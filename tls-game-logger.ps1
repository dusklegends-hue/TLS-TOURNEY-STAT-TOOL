<#
TLS TOURNEY STAT TOOL - Custom Game Logger
The Loading Screen
------------------------------------------
Run this while the League client is open, before/during a tournament custom.
Leave it running in a PowerShell window - it polls the client every few
seconds, and when a CUSTOM game finishes, it grabs the end-of-game stats
for all 10 participants and uploads them to the shared roster's database.

Only ONE person in the lobby needs to run this - the end-of-game data
already includes every participant, not just yours.

WORKS FOR A SPECTATOR TOO, by a different route. The script decides which
one it is on its own, and you do not pass a flag:

  - PLAYING: the end-of-game record is read from your own match history.
    Rich - damage split, gold, vision, objectives, bans, items.
  - SPECTATING: your account never played the game, so it is not in your
    match history and that route cannot work. Instead the script reads the
    live scoreboard out of the running game (port 2999), keeps the last
    snapshot, and uploads it when the game closes. Lighter - K/D/A, CS,
    level, items, spells, and objectives derived from the event feed, but
    no damage or gold, because the live feed does not carry them.

The two paths never both fire: a client either has an active player in the
game (playing) or does not (spectating).

This talks only to:
  - 127.0.0.1 (your own League client and the running game, while open)
  - ddragon.leagueoflegends.com (champion and spell names, no key needed)
  - firestore.googleapis.com (the shared database this app already uses)
It does not need your Riot API key and does not touch Riot's cloud API.

NOTE FROM CLAUDE: the League client's local API (LCU) is not officially
documented or guaranteed stable by Riot - this script is built from
community knowledge of how it behaves, but I have no way to test it
myself (no League client running in my environment). The first run
should be treated as a test: watch the console output, and if a step
fails or the captured data looks wrong, copy the console output and
report it back so the script can be fixed.
#>

# -BackfillGameId: upload one already-finished custom by its game id, then exit. For when the
# logger wasn't running (or a bug skipped the game) and the client is still open afterwards.
param([long]$BackfillGameId = 0)

$ErrorActionPreference = "Stop"
$FirestoreBase = "https://firestore.googleapis.com/v1/projects/champ-pool-lwg/databases/(default)/documents"
# Every document this script writes is tagged to the org and id-prefixed, so one collection
# can hold two tools' archives without either reading the other's games.
$Org = "TLS"
$DocPrefix = "tls-"
# The running game exposes a live scoreboard here. Same port whether you are playing or
# spectating, which is what makes one script cover both.
$LiveBase = "https://127.0.0.1:2999/liveclientdata"
$PollSeconds = 5

# --- TLS / self-signed cert handling (League's local API uses a self-signed cert) ---
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not ("TrustAllCertsPolicy" -as [type])) {
  Add-Type @"
    using System.Net;
    using System.Security.Cryptography.X509Certificates;
    public class TrustAllCertsPolicy : ICertificatePolicy {
      public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) {
        return true;
      }
    }
"@
}
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy

function Write-Log($msg) {
  Write-Output "[$(Get-Date -Format 'HH:mm:ss')] $msg"
}

function Get-LcuConnection {
  $port = $null
  $token = $null

  $proc = Get-CimInstance Win32_Process -Filter "Name = 'LeagueClientUx.exe'" -ErrorAction SilentlyContinue
  if ($proc -and $proc.CommandLine) {
    if ($proc.CommandLine -match '--app-port=(\d+)') { $port = $matches[1] }
    if ($proc.CommandLine -match '--remoting-auth-token=([\w-]+)') { $token = $matches[1] }
  }

  # A client running elevated hides its command line from an unelevated shell. The lockfile
  # (name:pid:port:password:protocol) carries the same port and token and is always readable.
  if (-not ($port -and $token)) {
    $lockfile = "C:\Riot Games\League of Legends\lockfile"
    if ($proc -and (Test-Path $lockfile)) {
      $parts = (Get-Content $lockfile -Raw -ErrorAction SilentlyContinue).Trim().Split(':')
      if ($parts.Count -ge 5) {
        $port = $parts[2]
        $token = $parts[3]
      }
    }
  }

  if (-not ($port -and $token)) { return $null }

  $authHeader = "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("riot:$token"))
  return [PSCustomObject]@{
    Base    = "https://127.0.0.1:$port"
    Headers = @{ Authorization = $authHeader }
  }
}

function Invoke-Lcu($conn, $path) {
  try {
    return Invoke-RestMethod -Uri "$($conn.Base)$path" -Headers $conn.Headers -Method Get
  } catch {
    return $null
  }
}

# The live endpoint needs no auth, and it simply is not there when no game is running - a
# failure here is the normal "no game" case, not an error worth reporting.
function Invoke-Live($path) {
  try {
    return Invoke-RestMethod -Uri "$LiveBase$path" -Method Get -TimeoutSec 5
  } catch {
    return $null
  }
}

# The live feed names champions and summoner spells; Firestore and the web app want the
# numeric ids. Data Dragon is a static CDN - no key, no rate limit.
$script:StaticMaps = $null
function Get-StaticMaps {
  if ($script:StaticMaps) { return $script:StaticMaps }

  $maps = @{ Champions = @{}; Spells = @{} }
  try {
    $versions = Invoke-RestMethod -Uri "https://ddragon.leagueoflegends.com/api/versions.json"
    $v = $versions[0]

    $champs = Invoke-RestMethod -Uri "https://ddragon.leagueoflegends.com/cdn/$v/data/en_US/champion.json"
    foreach ($prop in $champs.data.PSObject.Properties) {
      $c = $prop.Value
      # Both spellings: the live feed sends the display name ("Kai'Sa"), other places use the
      # id form ("Kaisa"), and matching either is free.
      $maps.Champions[[string]$c.name] = [int]$c.key
      $maps.Champions[[string]$c.id] = [int]$c.key
    }

    $spells = Invoke-RestMethod -Uri "https://ddragon.leagueoflegends.com/cdn/$v/data/en_US/summoner.json"
    foreach ($prop in $spells.data.PSObject.Properties) {
      $s = $prop.Value
      $maps.Spells[[string]$s.name] = [int]$s.key
    }
  } catch {
    Write-Log "Could not load champion/spell names from Data Dragon: $($_.Exception.Message)"
    Write-Log "Spectator captures will still upload, with championId 0 where the name could not be resolved."
  }

  $script:StaticMaps = $maps
  return $script:StaticMaps
}

function Get-TeamId($teamName) {
  if ($teamName -eq "CHAOS") { return 200 }
  return 100
}

# The live scoreboard has no damage, gold, healing or CC score - Riot does not put them in it.
# The client may still hold them: it renders a full end-of-game screen for spectators, and that
# screen's data has to come from somewhere. These are the candidates, in the order they would
# be preferred. Nobody here can test them without a real spectated game, so rather than guess a
# payload shape and write a converter against it, this probes each one and reports what came
# back. One spectated scrim turns the question into an answer.
function Test-SpectatorStatSources($conn, $gameId) {
  if (-not $conn) { return }

  $candidates = @(
    @{ Name = "eog-stats-block"; Path = "/lol-end-of-game/v1/eog-stats-block" },
    @{ Name = "eog-sco-block";   Path = "/lol-end-of-game/v1/eog-stats-block-sco" }
  )
  # Only worth asking about a specific game when the client gave us its id at all.
  if ($gameId) {
    $candidates += @{ Name = "replay-metadata"; Path = "/lol-replays/v1/metadata/$gameId" }
    $candidates += @{ Name = "match-history";   Path = "/lol-match-history/v1/games/$gameId" }
  }

  Write-Log "--- probing for full spectator stats (report this block) ---"
  foreach ($c in $candidates) {
    $resp = Invoke-Lcu $conn $c.Path
    if (-not $resp) {
      Write-Log ("  {0}: no data" -f $c.Name)
      continue
    }

    $json = $resp | ConvertTo-Json -Depth 4 -Compress
    $hasDamage = $json -match 'DAMAGE|damageDealt|totalDamage'
    $hasGold   = $json -match 'GOLD|goldEarned'
    Write-Log ("  {0}: RESPONDED ({1} chars){2}{3}" -f $c.Name, $json.Length, $(if ($hasDamage) { " damage:yes" } else { " damage:no" }), $(if ($hasGold) { " gold:yes" } else { " gold:no" }))
    Write-Log ("    top-level keys: {0}" -f (($resp.PSObject.Properties | Select-Object -First 15 | ForEach-Object { $_.Name }) -join ", "))
  }
  Write-Log "--- end probe ---"
}

# Objectives are not in the live scoreboard, but they are all in its event feed, so they can be
# counted back out of it. Credit goes to the killer's team; when a turret falls to minions there
# is no killer to look up, so the turret's own name decides it - Turret_T1_* are blue's
# structures, so red took it.
function Build-LiveTeams($live) {
  $players = @($live.allPlayers)
  $teams = @{}
  foreach ($id in 100, 200) {
    $teams[$id] = [ordered]@{
      teamId = $id; firstBlood = $false; firstTower = $false; firstInhibitor = $false
      firstBaron = $false; firstDragon = $false; firstRiftHerald = $false
      towerKills = 0; inhibitorKills = 0; baronKills = 0; dragonKills = 0; riftHeraldKills = 0
    }
  }

  $teamOf = {
    param($name)
    if (-not $name) { return $null }
    $p = $players | Where-Object {
      $_.summonerName -eq $name -or $_.riotId -eq $name -or $_.riotIdGameName -eq $name
    } | Select-Object -First 1
    if ($p) { return (Get-TeamId $p.team) }
    return $null
  }

  foreach ($e in @($live.events.Events)) {
    $killerTeam = & $teamOf $e.KillerName

    switch ($e.EventName) {
      "ChampionKill" {
        if ($killerTeam -and -not ($teams[100].firstBlood -or $teams[200].firstBlood)) {
          $teams[$killerTeam].firstBlood = $true
        }
      }
      "FirstBlood" {
        $recipientTeam = & $teamOf $e.Recipient
        if ($recipientTeam) { $teams[$recipientTeam].firstBlood = $true }
      }
      "DragonKill" {
        if ($killerTeam) {
          $teams[$killerTeam].dragonKills++
          if (-not ($teams[100].firstDragon -or $teams[200].firstDragon)) { $teams[$killerTeam].firstDragon = $true }
        }
      }
      "BaronKill" {
        if ($killerTeam) {
          $teams[$killerTeam].baronKills++
          if (-not ($teams[100].firstBaron -or $teams[200].firstBaron)) { $teams[$killerTeam].firstBaron = $true }
        }
      }
      "HeraldKill" {
        if ($killerTeam) {
          $teams[$killerTeam].riftHeraldKills++
          if (-not ($teams[100].firstRiftHerald -or $teams[200].firstRiftHerald)) { $teams[$killerTeam].firstRiftHerald = $true }
        }
      }
      "TurretKilled" {
        $credited = $killerTeam
        if (-not $credited -and $e.TurretKilled -match '^Turret_T(\d)_') {
          $credited = if ($matches[1] -eq "1") { 200 } else { 100 }
        }
        if ($credited) {
          $teams[$credited].towerKills++
          if (-not ($teams[100].firstTower -or $teams[200].firstTower)) { $teams[$credited].firstTower = $true }
        }
      }
      "InhibKilled" {
        $credited = $killerTeam
        if (-not $credited -and $e.InhibKilled -match '^Barracks_T(\d)_') {
          $credited = if ($matches[1] -eq "1") { 200 } else { 100 }
        }
        if ($credited) {
          $teams[$credited].inhibitorKills++
          if (-not ($teams[100].firstInhibitor -or $teams[200].firstInhibitor)) { $teams[$credited].firstInhibitor = $true }
        }
      }
    }
  }

  return $teams
}


# Per-player totals the live scoreboard omits but its event feed contains: structures taken,
# best multikill, and the longest unbroken killing spree.
function Build-LiveDerived($live) {
  $out = @{}
  foreach ($p in @($live.allPlayers)) {
    $name = if ($p.riotId) { [string]$p.riotId } else { [string]$p.summonerName }
    $out[$name] = @{ TurretKills = 0; InhibKills = 0; LargestMulti = 0; LargestSpree = 0; Spree = 0 }
  }

  foreach ($e in @($live.events.Events)) {
    $killer = [string]$e.KillerName
    switch ($e.EventName) {
      "TurretKilled" { if ($out.ContainsKey($killer)) { $out[$killer].TurretKills++ } }
      "InhibKilled"  { if ($out.ContainsKey($killer)) { $out[$killer].InhibKills++ } }
      "Multikill"    { if ($out.ContainsKey($killer) -and [int]$e.KillStreak -gt $out[$killer].LargestMulti) { $out[$killer].LargestMulti = [int]$e.KillStreak } }
      "ChampionKill" {
        if ($out.ContainsKey($killer)) {
          $out[$killer].Spree++
          if ($out[$killer].Spree -gt $out[$killer].LargestSpree) { $out[$killer].LargestSpree = $out[$killer].Spree }
        }
        # A death ends that player's spree, which is what makes it a spree rather than a total.
        $victim = [string]$e.VictimName
        if ($out.ContainsKey($victim)) { $out[$victim].Spree = 0 }
      }
    }
  }
  return $out
}

# The event feed as a flat, readable list with timestamps, ready for the site to render.
function Build-LiveTimeline($live) {
  $rows = @()
  foreach ($e in @($live.events.Events)) {
    $t = [double]$e.EventTime
    $text = switch ($e.EventName) {
      "ChampionKill" { "{0} killed {1}" -f $e.KillerName, $e.VictimName }
      "FirstBlood"   { "First blood - {0}" -f $e.Recipient }
      "TurretKilled" { "Turret down ({0}) to {1}" -f $e.TurretKilled, $e.KillerName }
      "InhibKilled"  { "Inhibitor down ({0}) to {1}" -f $e.InhibKilled, $e.KillerName }
      "DragonKill"   { "{0} drake to {1}{2}" -f $e.DragonType, $e.KillerName, $(if ($e.Stolen -eq "True") { " (STOLEN)" } else { "" }) }
      "BaronKill"    { "Baron to {0}{1}" -f $e.KillerName, $(if ($e.Stolen -eq "True") { " (STOLEN)" } else { "" }) }
      "HeraldKill"   { "Herald to {0}{1}" -f $e.KillerName, $(if ($e.Stolen -eq "True") { " (STOLEN)" } else { "" }) }
      "Multikill"    { "{0}x multikill - {1}" -f $e.KillStreak, $e.KillerName }
      "Ace"          { "Ace - {0}" -f $e.Acer }
      "GameEnd"      { "Game end ({0})" -f $e.Result }
      default        { [string]$e.EventName }
    }
    if ($text) {
      $rows += @{ mapValue = @{ fields = @{
        t    = @{ doubleValue = [double]$t }
        text = @{ stringValue = [string]$text }
      } } }
    }
  }
  return $rows
}

# CS at the 10, 15 and 20 minute marks, taken from the closest poll to each. Only a spectator
# capture can produce these - the end-of-game record holds totals and nothing in between.
function Get-SampleMilestones($samples) {
  $out = @{}
  if (-not $samples -or $samples.Count -eq 0) { return $out }

  foreach ($minute in 10, 15, 20) {
    $target = $minute * 60
    $closest = $null
    foreach ($sample in $samples) {
      if ($sample.T -le ($target + 30)) { $closest = $sample } else { break }
    }
    if (-not $closest -or $closest.T -lt ($target - 60)) { continue }
    foreach ($name in $closest.Cs.Keys) {
      if (-not $out.ContainsKey($name)) { $out[$name] = @{ Cs10 = 0; Cs15 = 0; Cs20 = 0 } }
      $out[$name]["Cs$minute"] = [int]$closest.Cs[$name]
    }
  }
  return $out
}

# Uploads a spectator capture. Deliberately the same document shape the match-history path
# writes, so the Customs tab needs no special case - just fewer fields filled in, and a
# source marker so nobody mistakes a light record for a lost one.
function Send-LiveGameToFirestore($gameId, $live, $winningTeamId, $rawResult, $samples) {
  $maps = Get-StaticMaps

  $peopleResp = Invoke-RestMethod -Uri "$FirestoreBase/people"
  $roster = @()
  if ($peopleResp.documents) {
    foreach ($doc in $peopleResp.documents) {
      $id = ($doc.name -split '/')[-1]
      $name = $doc.fields.name.stringValue
      $riotId = $doc.fields.riotId.stringValue
      if ($riotId) {
        $roster += [PSCustomObject]@{ Id = $id; Name = $name; RiotId = $riotId.ToLower() }
      }
    }
  }

  # Per-player numbers the live feed does not state but its event feed implies.
  $derived = Build-LiveDerived $live
  $samplesFor = Get-SampleMilestones $samples

  $participantFields = @()
  foreach ($p in @($live.allPlayers)) {
    $displayName = if ($p.riotId) {
      [string]$p.riotId
    } elseif ($p.riotIdGameName -and $p.riotIdTagLine) {
      "$($p.riotIdGameName)#$($p.riotIdTagLine)"
    } else {
      [string]$p.summonerName
    }

    $matchedPerson = $roster | Where-Object { $_.RiotId -eq $displayName.ToLower() } | Select-Object -First 1
    $teamId = Get-TeamId $p.team
    $championId = 0
    if ($p.championName -and $maps.Champions.ContainsKey([string]$p.championName)) {
      $championId = $maps.Champions[[string]$p.championName]
    }

    $spellId = {
      param($spell)
      if ($spell -and $spell.displayName -and $maps.Spells.ContainsKey([string]$spell.displayName)) {
        return $maps.Spells[[string]$spell.displayName]
      }
      return 0
    }

    # Unknown result stays unknown. Writing false here would render as a defeat for all ten
    # players, which is worse than saying nothing.
    $winField = if ($null -eq $winningTeamId) { @{ nullValue = $null } } else { @{ booleanValue = ($teamId -eq $winningTeamId) } }

    $participantFields += @{
      mapValue = @{
        fields = @{
          summonerName      = @{ stringValue = $displayName }
          championId        = ConvertTo-FirestoreInt $championId
          kills             = ConvertTo-FirestoreInt $p.scores.kills
          deaths            = ConvertTo-FirestoreInt $p.scores.deaths
          assists           = ConvertTo-FirestoreInt $p.scores.assists
          win               = $winField
          teamId            = ConvertTo-FirestoreInt $teamId
          cs                = ConvertTo-FirestoreInt $p.scores.creepScore
          visionScore       = ConvertTo-FirestoreInt ([math]::Round([double]$p.scores.wardScore))
          champLevel        = ConvertTo-FirestoreInt $p.level
          position          = @{ stringValue = [string]$p.position }
          spell1Id          = ConvertTo-FirestoreInt (& $spellId $p.summonerSpells.summonerSpellOne)
          spell2Id          = ConvertTo-FirestoreInt (& $spellId $p.summonerSpells.summonerSpellTwo)
          # From the stats reference: everything else the live feed carries.
          wardScore         = ConvertTo-FirestoreInt ([math]::Round([double]$p.scores.wardScore))
          skin              = @{ stringValue = [string]$p.skinName }
          isDead            = ConvertTo-FirestoreBool $p.isDead
          respawnTimer      = ConvertTo-FirestoreInt ([math]::Round([double]$p.respawnTimer))
          # No gold earned in the live feed; what the build cost is the closest honest proxy.
          goldSpent         = ConvertTo-FirestoreInt (@($p.items) | ForEach-Object { [int]$_.price } | Measure-Object -Sum).Sum
          runes             = @{ arrayValue = @{ values = @(
                                @($p.runes.keystone.id, $p.runes.primaryRuneTree.id, $p.runes.secondaryRuneTree.id) |
                                  ForEach-Object { @{ integerValue = [string][int]$_ } }
                              ) } }
          turretKills       = ConvertTo-FirestoreInt ($derived[$displayName].TurretKills)
          inhibitorKills    = ConvertTo-FirestoreInt ($derived[$displayName].InhibKills)
          largestMultiKill  = ConvertTo-FirestoreInt ($derived[$displayName].LargestMulti)
          largestSpree      = ConvertTo-FirestoreInt ($derived[$displayName].LargestSpree)
          csAt10            = ConvertTo-FirestoreInt ($samplesFor[$displayName].Cs10)
          csAt15            = ConvertTo-FirestoreInt ($samplesFor[$displayName].Cs15)
          csAt20            = ConvertTo-FirestoreInt ($samplesFor[$displayName].Cs20)
          items             = @{ arrayValue = @{ values = @(
                                @($p.items) | ForEach-Object { @{ integerValue = [string][int]$_.itemID } }
                              ) } }
          matchedPersonId   = if ($matchedPerson) { @{ stringValue = $matchedPerson.Id } } else { @{ nullValue = $null } }
          matchedPersonName = if ($matchedPerson) { @{ stringValue = $matchedPerson.Name } } else { @{ nullValue = $null } }
        }
      }
    }
  }

  $teamFields = @()
  foreach ($t in (Build-LiveTeams $live).Values) {
    $teamFields += @{
      mapValue = @{
        fields = @{
          teamId          = ConvertTo-FirestoreInt  $t.teamId
          firstBlood      = ConvertTo-FirestoreBool $t.firstBlood
          firstTower      = ConvertTo-FirestoreBool $t.firstTower
          firstInhibitor  = ConvertTo-FirestoreBool $t.firstInhibitor
          firstBaron      = ConvertTo-FirestoreBool $t.firstBaron
          firstDragon     = ConvertTo-FirestoreBool $t.firstDragon
          firstRiftHerald = ConvertTo-FirestoreBool $t.firstRiftHerald
          towerKills      = ConvertTo-FirestoreInt  $t.towerKills
          inhibitorKills  = ConvertTo-FirestoreInt  $t.inhibitorKills
          baronKills      = ConvertTo-FirestoreInt  $t.baronKills
          dragonKills     = ConvertTo-FirestoreInt  $t.dragonKills
          riftHeraldKills = ConvertTo-FirestoreInt  $t.riftHeraldKills
          bans            = @{ arrayValue = @{ values = @() } }
        }
      }
    }
  }

  $body = @{
    fields = @{
      gameId              = @{ integerValue = [string]$gameId }
      capturedAt          = @{ timestampValue = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
      gameDurationSeconds = ConvertTo-FirestoreInt ([math]::Round([double]$live.gameData.gameTime))
      participants        = @{ arrayValue = @{ values = $participantFields } }
      teams               = @{ arrayValue = @{ values = $teamFields } }
      org                 = @{ stringValue = $Org }
      source              = @{ stringValue = "spectator" }
      resultKnown         = ConvertTo-FirestoreBool ($null -ne $winningTeamId)
      # Kept raw so the first real spectator capture tells us how to read it, instead of the
      # script guessing whose side "Win" refers to when nobody is playing.
      liveResultRaw       = @{ stringValue = [string]$rawResult }
      mapTerrain          = @{ stringValue = [string]$live.gameData.mapTerrain }
      # The whole reason a spectator capture is worth having: every objective and kill with the
      # minute it happened on. The end-of-game record only ever says who was first, never when.
      timeline            = @{ arrayValue = @{ values = @(Build-LiveTimeline $live) } }
    }
  } | ConvertTo-Json -Depth 20

  Invoke-RestMethod -Uri "$FirestoreBase/customGames?documentId=$DocPrefix$gameId" -Method Post -Body $body -ContentType "application/json" | Out-Null
}

# The client leaves objective counters out of the payload entirely when they're zero, so a
# missing field means "none taken" rather than "unknown" - coerce both to 0 instead of letting
# a null reach Firestore, which would reject the write.
function ConvertTo-FirestoreInt($value) {
  if ($null -eq $value) { return @{ integerValue = "0" } }
  return @{ integerValue = [string][int]$value }
}

# Timeline deltas arrive as an object keyed by minute range ("0-10", "10-20", ...). Stored as
# a map so the buckets keep their names instead of becoming a positional array nobody can read.
function ConvertTo-FirestoreDeltas($deltas) {
  if ($null -eq $deltas) { return @{ nullValue = $null } }
  $fields = @{}
  foreach ($prop in $deltas.PSObject.Properties) {
    $fields[$prop.Name] = @{ doubleValue = [double]$prop.Value }
  }
  if ($fields.Count -eq 0) { return @{ nullValue = $null } }
  return @{ mapValue = @{ fields = $fields } }
}

function ConvertTo-FirestoreBool($value) {
  return @{ booleanValue = [bool]$value }
}

function Send-CustomGameToFirestore($gameId, $matchData) {
  # Pull the current roster so we can match participants by Riot ID.
  $peopleResp = Invoke-RestMethod -Uri "$FirestoreBase/people"
  $roster = @()
  if ($peopleResp.documents) {
    foreach ($doc in $peopleResp.documents) {
      $id = ($doc.name -split '/')[-1]
      $name = $doc.fields.name.stringValue
      $riotId = $doc.fields.riotId.stringValue
      if ($riotId) {
        $roster += [PSCustomObject]@{ Id = $id; Name = $name; RiotId = $riotId.ToLower() }
      }
    }
  }

  $participantFields = @()
  foreach ($p in $matchData.participants) {
    $identity = $matchData.participantIdentities | Where-Object { $_.participantId -eq $p.participantId }
    $playerInfo = $identity.player
    $riotIdGuess = $null
    if ($playerInfo.gameName -and $playerInfo.tagLine) {
      $riotIdGuess = "$($playerInfo.gameName)#$($playerInfo.tagLine)".ToLower()
    } elseif ($playerInfo.summonerName) {
      $riotIdGuess = $playerInfo.summonerName.ToLower()
    }

    $matchedPerson = $null
    if ($riotIdGuess) {
      $matchedPerson = $roster | Where-Object { $_.RiotId -eq $riotIdGuess } | Select-Object -First 1
    }

    $displayName = if ($playerInfo.gameName -and $playerInfo.tagLine) {
      "$($playerInfo.gameName)#$($playerInfo.tagLine)"
    } else {
      [string]$playerInfo.summonerName
    }

    $participantFields += @{
      mapValue = @{
        fields = @{
          summonerName      = @{ stringValue = $displayName }
          championId        = @{ integerValue = [string]$p.championId }
          kills             = @{ integerValue = [string]$p.stats.kills }
          deaths            = @{ integerValue = [string]$p.stats.deaths }
          assists           = @{ integerValue = [string]$p.stats.assists }
          win               = @{ booleanValue = [bool]$p.stats.win }
          teamId            = @{ integerValue = [string]$p.teamId }
          # Damage, split by type and target. The split matters for review: "low damage" reads
          # differently on a tank (check mitigated/taken) than on a carry (check share and DPM).
          damageToChampions   = ConvertTo-FirestoreInt $p.stats.totalDamageDealtToChampions
          physicalToChampions = ConvertTo-FirestoreInt $p.stats.physicalDamageDealtToChampions
          magicToChampions    = ConvertTo-FirestoreInt $p.stats.magicDamageDealtToChampions
          trueToChampions     = ConvertTo-FirestoreInt $p.stats.trueDamageDealtToChampions
          damageTaken         = ConvertTo-FirestoreInt $p.stats.totalDamageTaken
          damageMitigated     = ConvertTo-FirestoreInt $p.stats.damageSelfMitigated
          damageToObjectives  = ConvertTo-FirestoreInt $p.stats.damageDealtToObjectives
          damageToTurrets     = ConvertTo-FirestoreInt $p.stats.damageDealtToTurrets
          totalHeal           = ConvertTo-FirestoreInt $p.stats.totalHeal
          ccScore             = ConvertTo-FirestoreInt $p.stats.timeCCingOthers

          # Economy and farm. Team-jungle vs enemy-jungle CS separates "farmed own camps"
          # from "invaded and stole" - a jungler review can't be done without it.
          goldEarned          = ConvertTo-FirestoreInt $p.stats.goldEarned
          goldSpent           = ConvertTo-FirestoreInt $p.stats.goldSpent
          cs                  = ConvertTo-FirestoreInt ([int]$p.stats.totalMinionsKilled + [int]$p.stats.neutralMinionsKilled)
          laneCs              = ConvertTo-FirestoreInt $p.stats.totalMinionsKilled
          jungleCsOwn         = ConvertTo-FirestoreInt $p.stats.neutralMinionsKilledTeamJungle
          jungleCsEnemy       = ConvertTo-FirestoreInt $p.stats.neutralMinionsKilledEnemyJungle
          champLevel          = ConvertTo-FirestoreInt $p.stats.champLevel

          # Vision, the stat scrim teams argue about most.
          visionScore         = ConvertTo-FirestoreInt $p.stats.visionScore
          wardsPlaced         = ConvertTo-FirestoreInt $p.stats.wardsPlaced
          wardsKilled         = ConvertTo-FirestoreInt $p.stats.wardsKilled
          controlWardsBought  = ConvertTo-FirestoreInt $p.stats.visionWardsBoughtInGame

          # Kill patterns and early-game firsts.
          largestMultiKill    = ConvertTo-FirestoreInt $p.stats.largestMultiKill
          largestSpree        = ConvertTo-FirestoreInt $p.stats.largestKillingSpree
          doubleKills         = ConvertTo-FirestoreInt $p.stats.doubleKills
          tripleKills         = ConvertTo-FirestoreInt $p.stats.tripleKills
          quadraKills         = ConvertTo-FirestoreInt $p.stats.quadraKills
          pentaKills          = ConvertTo-FirestoreInt $p.stats.pentaKills
          firstBloodKill      = ConvertTo-FirestoreBool $p.stats.firstBloodKill
          firstTowerKill      = ConvertTo-FirestoreBool $p.stats.firstTowerKill
          turretKills         = ConvertTo-FirestoreInt $p.stats.turretKills
          inhibitorKills      = ConvertTo-FirestoreInt $p.stats.inhibitorKills
          longestTimeAlive    = ConvertTo-FirestoreInt $p.stats.longestTimeSpentLiving

          # Added from the stats reference: everything the match record already carried and
          # the old logger threw away.
          totalDamageDealt    = ConvertTo-FirestoreInt $p.stats.totalDamageDealt
          largestCrit         = ConvertTo-FirestoreInt $p.stats.largestCriticalStrike
          totalUnitsHealed    = ConvertTo-FirestoreInt $p.stats.totalUnitsHealed
          killingSprees       = ConvertTo-FirestoreInt $p.stats.killingSprees
          unrealKills         = ConvertTo-FirestoreInt $p.stats.unrealKills
          sightWardsBought    = ConvertTo-FirestoreInt $p.stats.sightWardsBoughtInGame
          firstBloodAssist    = ConvertTo-FirestoreBool $p.stats.firstBloodAssist
          firstTowerAssist    = ConvertTo-FirestoreBool $p.stats.firstTowerAssist
          firstInhibitorKill  = ConvertTo-FirestoreBool $p.stats.firstInhibitorKill
          firstInhibAssist    = ConvertTo-FirestoreBool $p.stats.firstInhibitorAssist

          # The full rune page, not just the keystone: six perks plus both trees.
          runes               = @{ arrayValue = @{ values = @(
                                  @($p.stats.perk0, $p.stats.perk1, $p.stats.perk2,
                                    $p.stats.perk3, $p.stats.perk4, $p.stats.perk5) |
                                    ForEach-Object { @{ integerValue = [string][int]$_ } }
                                ) } }
          runePrimaryStyle    = ConvertTo-FirestoreInt $p.stats.perkPrimaryStyle
          runeSubStyle        = ConvertTo-FirestoreInt $p.stats.perkSubStyle

          # Laning phase, measured. The deltas are per 10-minute bucket, and the diff versions
          # are against the direct lane opponent - the only read on laning either route can
          # produce without watching the game.
          lane                = @{ stringValue = [string]$p.timeline.lane }
          roleSlot            = @{ stringValue = [string]$p.timeline.role }
          csPerMinDeltas      = ConvertTo-FirestoreDeltas $p.timeline.creepsPerMinDeltas
          goldPerMinDeltas    = ConvertTo-FirestoreDeltas $p.timeline.goldPerMinDeltas
          xpPerMinDeltas      = ConvertTo-FirestoreDeltas $p.timeline.xpPerMinDeltas
          damageTakenDeltas   = ConvertTo-FirestoreDeltas $p.timeline.damageTakenPerMinDeltas
          csDiffDeltas        = ConvertTo-FirestoreDeltas $p.timeline.csDiffPerMinDeltas
          xpDiffDeltas        = ConvertTo-FirestoreDeltas $p.timeline.xpDiffPerMinDeltas
          damageTakenDiffs    = ConvertTo-FirestoreDeltas $p.timeline.damageTakenDiffPerMinDeltas

          # The loadout: spells and final build, for "what did you even buy" review moments.
          spell1Id            = ConvertTo-FirestoreInt $p.spell1Id
          spell2Id            = ConvertTo-FirestoreInt $p.spell2Id
          items               = @{ arrayValue = @{ values = @(
                                  @($p.stats.item0, $p.stats.item1, $p.stats.item2, $p.stats.item3,
                                    $p.stats.item4, $p.stats.item5, $p.stats.item6) |
                                    ForEach-Object { @{ integerValue = [string][int]$_ } }
                                ) } }
          matchedPersonId   = if ($matchedPerson) { @{ stringValue = $matchedPerson.Id } } else { @{ nullValue = $null } }
          matchedPersonName = if ($matchedPerson) { @{ stringValue = $matchedPerson.Name } } else { @{ nullValue = $null } }
        }
      }
    }
  }

  # Objective control: who took what, per side. The scoreboard already tells you who won -
  # this tells you how, which is the half you can actually practise.
  $teamFields = @()
  foreach ($t in $matchData.teams) {
    $teamFields += @{
      mapValue = @{
        fields = @{
          teamId          = ConvertTo-FirestoreInt  $t.teamId
          firstBlood      = ConvertTo-FirestoreBool $t.firstBlood
          firstTower      = ConvertTo-FirestoreBool $t.firstTower
          firstInhibitor  = ConvertTo-FirestoreBool $t.firstInhibitor
          firstBaron      = ConvertTo-FirestoreBool $t.firstBaron
          firstDragon     = ConvertTo-FirestoreBool $t.firstDragon
          firstRiftHerald = ConvertTo-FirestoreBool $t.firstRiftHerald
          towerKills      = ConvertTo-FirestoreInt  $t.towerKills
          inhibitorKills  = ConvertTo-FirestoreInt  $t.inhibitorKills
          baronKills      = ConvertTo-FirestoreInt  $t.baronKills
          dragonKills     = ConvertTo-FirestoreInt  $t.dragonKills
          riftHeraldKills = ConvertTo-FirestoreInt  $t.riftHeraldKills
          # Customs are the one place bans are a real team decision (in solo queue they're ten
          # strangers' picks), so a tournament-draft custom's bans are worth keeping.
          bans            = @{ arrayValue = @{ values = @(
                              @($t.bans) | Where-Object { $_ -and $_.championId -gt 0 } |
                                ForEach-Object { @{ integerValue = [string]$_.championId } }
                            ) } }
        }
      }
    }
  }

  $body = @{
    fields = @{
      gameId              = @{ integerValue = [string]$gameId }
      capturedAt          = @{ timestampValue = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
      gameDurationSeconds = @{ integerValue = [string]$matchData.gameDuration }
      participants        = @{ arrayValue = @{ values = $participantFields } }
      teams               = @{ arrayValue = @{ values = $teamFields } }
      org                 = @{ stringValue = $Org }
      source              = @{ stringValue = "player" }
      resultKnown         = ConvertTo-FirestoreBool $true
      gameVersion         = @{ stringValue = [string]$matchData.gameVersion }
      queueId             = ConvertTo-FirestoreInt $matchData.queueId
      mapId               = ConvertTo-FirestoreInt $matchData.mapId
    }
  } | ConvertTo-Json -Depth 20

  Invoke-RestMethod -Uri "$FirestoreBase/customGames?documentId=$DocPrefix$gameId" -Method Post -Body $body -ContentType "application/json" | Out-Null
}

if ($BackfillGameId) {
  $conn = Get-LcuConnection
  if (-not $conn) { Write-Log "Backfill needs the League client open on the account that played the game."; exit 1 }
  $matchData = Invoke-Lcu $conn "/lol-match-history/v1/games/$BackfillGameId"
  if (-not $matchData -or -not $matchData.participants) { Write-Log "Could not read game $BackfillGameId from the client."; exit 1 }
  if ($matchData.gameType -ne "CUSTOM_GAME") { Write-Log ("Game {0} is not a custom (gameType={1}) - refusing to log it." -f $BackfillGameId, $matchData.gameType); exit 1 }
  Send-CustomGameToFirestore -gameId $BackfillGameId -matchData $matchData
  Write-Log "Backfilled custom game $BackfillGameId - it should be on the Customs tab now."
  exit 0
}

Write-Log "Custom Game Logger starting. Waiting for League client..."
Write-Log "Playing or spectating both work - the script picks the right route on its own."

$loggedGameIds = @{}
$lastPhase = $null
$capturedGameId = $null
$capturedQueueId = $null

# Spectator state. The live snapshot is refreshed every poll while a game is up, because once
# the game closes the endpoint is gone and whatever was last read is all there will ever be.
$liveSnapshot = $null
$liveIsSpectator = $false
$liveWasUp = $false
# One row per poll: the clock, and every player's CS and level at that moment. This is the only
# way to know what the game looked like at 10 minutes - the end-of-game record has totals only.
$liveSamples = @()

while ($true) {
  # --- live game watch, independent of the client: a spectator never reaches EndOfGame, so
  # the game closing is the only end-of-game signal that route gets.
  $live = Invoke-Live "/allgamedata"
  if ($live -and $live.allPlayers) {
    if (-not $liveWasUp) {
      # activePlayer exists only for someone actually in the game. Its absence is what marks
      # this client as a spectator, and it is the whole basis for choosing a route.
      $liveSamples = @()
      $liveIsSpectator = -not ($live.activePlayer -and $live.activePlayer.summonerName)
      Write-Log ("Live game detected - this client is {0}." -f $(if ($liveIsSpectator) { "SPECTATING (will capture the live scoreboard)" } else { "PLAYING (will use match history at the end)" }))
      $liveWasUp = $true
    }
    $liveSnapshot = $live

    if ($liveIsSpectator) {
      $cs = @{}
      $levels = @{}
      foreach ($p in @($live.allPlayers)) {
        $name = if ($p.riotId) { [string]$p.riotId } else { [string]$p.summonerName }
        $cs[$name] = [int]$p.scores.creepScore
        $levels[$name] = [int]$p.level
      }
      $liveSamples += [PSCustomObject]@{ T = [double]$live.gameData.gameTime; Cs = $cs; Levels = $levels }
    }
  } elseif ($liveWasUp) {
    $liveWasUp = $false
    $finished = $liveSnapshot
    $liveSnapshot = $null

    if ($liveIsSpectator -and $finished) {
      $mode = [string]$finished.gameData.gameMode
      $endEvent = @($finished.events.Events) | Where-Object { $_.EventName -eq "GameEnd" } | Select-Object -First 1
      $rawResult = [string]$endEvent.Result

      # No account to anchor "Win" to when spectating, so the winner is left unset rather than
      # guessed. The Customs tab shows an unresolved game as such and lets you set the side.
      $winningTeamId = $null

      # A synthetic id, well above the range real game ids occupy, so it cannot collide with a
      # match-history upload of the same scrim.
      $syntheticId = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())

      Write-Log "Spectated game ended (mode=$mode, GameEnd result='$rawResult'). Uploading the live capture..."
      # The live feed carries no damage, gold, healing or CC score. The client might still have
      # them; this says whether it does, without risking the capture we already have.
      try { Test-SpectatorStatSources $conn $capturedGameId } catch { Write-Log "Stat-source probe failed: $($_.Exception.Message)" }

      try {
        Send-LiveGameToFirestore -gameId $syntheticId -live $finished -winningTeamId $winningTeamId -rawResult $rawResult -samples $liveSamples
        Write-Log "Spectator capture $syntheticId uploaded - set the winning side on the Customs tab."
        Write-Log "First spectator run: please report the GameEnd result above, so the winner can be read automatically next time."
      } catch {
        Write-Log "Failed to upload the spectator capture: $($_.Exception.Message)"
      }
    }
  }

  $conn = Get-LcuConnection
  if (-not $conn) {
    Write-Log "League client not detected. Retrying in $PollSeconds s..."
    Start-Sleep -Seconds $PollSeconds
    continue
  }

  $phase = Invoke-Lcu $conn "/lol-gameflow/v1/gameflow-phase"
  if ($null -eq $phase) {
    Start-Sleep -Seconds $PollSeconds
    continue
  }

  if ($phase -ne $lastPhase) {
    Write-Log "Gameflow phase: $phase"
    $lastPhase = $phase
  }

  # Remember the gameId while a game is actually in progress, since it may
  # not be easily available once we reach the end-of-game screen.
  if ($phase -eq "InProgress" -or $phase -eq "ChampSelect") {
    $session = Invoke-Lcu $conn "/lol-gameflow/v1/session"
    if ($session -and $session.gameData -and $session.gameData.gameId) {
      $capturedGameId = $session.gameData.gameId
      $capturedQueueId = $session.gameData.queue.id
    }
  }

  if (($phase -eq "EndOfGame" -or $phase -eq "PreEndOfGame" -or $phase -eq "WaitingForStats") -and $capturedGameId) {
    if ($loggedGameIds.ContainsKey([string]$capturedGameId)) {
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    Write-Log "Game ended (gameId=$capturedGameId, queueId=$capturedQueueId). Checking if it was a custom game..."

    $matchData = Invoke-Lcu $conn "/lol-match-history/v1/games/$capturedGameId"
    if (-not $matchData -or -not $matchData.participants) {
      Write-Log "Could not read match history for gameId=$capturedGameId. Raw response:"
      Write-Log ($matchData | ConvertTo-Json -Depth 6 -Compress)
      Write-Log "This likely means the LCU endpoint/field names differ from what this script expects - please report this output."
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    # The match record's own gameType is the authority. Queue ids are NOT reliable for this:
    # the client reported queueId 3100 for a plain tournament-draft custom on 2026-08-14, and
    # the old `queueId -eq 0` check silently skipped a real scrim because of it.
    if ($matchData.gameType -ne "CUSTOM_GAME") {
      Write-Log ("Not a custom game (gameType={0}, queueId={1}) - skipping, ranked/normals are covered by the Matches/Stats tabs." -f $matchData.gameType, $capturedQueueId)
      $loggedGameIds[[string]$capturedGameId] = $true
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    try {
      Send-CustomGameToFirestore -gameId $capturedGameId -matchData $matchData
      $loggedGameIds[[string]$capturedGameId] = $true
      Write-Log "Custom game $capturedGameId uploaded successfully."
    } catch {
      Write-Log "Failed to upload custom game: $($_.Exception.Message)"
    }
  }

  Start-Sleep -Seconds $PollSeconds
}
