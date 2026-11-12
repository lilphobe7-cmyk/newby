. "$PSScriptRoot\tokens.ps1"

$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$token = $auth.access_token

# Pick two AWAITING_ASSIGNMENT SIMs from BATCH-002 that the main agent holds
# For the test, we'll use SIMs that are still awaiting assignment
$simsUrl = "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/sims-list?workspace_id=$MAINAGENT1_WORKSPACE&status=AWAITING_ASSIGNMENT&limit=2"

$sims = Invoke-RestMethod `
  -Uri $simsUrl `
  -Method GET -Headers @{ Authorization = "Bearer $token" }

if ($sims.sims.Count -lt 2) {
  Write-Host "Not enough AWAITING_ASSIGNMENT SIMs. Need at least 2." -ForegroundColor Red
  exit 1
}

$sim1 = $sims.sims[0]
$sim2 = $sims.sims[1]

Write-Host "Testing offline ingest for:" -ForegroundColor Cyan
Write-Host "  $($sim1.iccid)"
Write-Host "  $($sim2.iccid)"

# Build two offline events
$events = @(
  @{
    event_id         = [guid]::NewGuid().ToString()
    sim_id           = $sim1.id
    action           = "REGISTRATION_REPORTED"
    device_timestamp = (Get-Date).ToUniversalTime().ToString("o")
    payload          = @{
      phone_number = "0722111111"
      notes        = "Synced from offline"
    }
  },
  @{
    event_id         = [guid]::NewGuid().ToString()
    sim_id           = $sim2.id
    action           = "REGISTRATION_REPORTED"
    device_timestamp = (Get-Date).ToUniversalTime().ToString("o")
    payload          = @{
      phone_number = "0722222222"
      notes        = "Synced from offline"
    }
  }
)

$body = @{ events = $events } | ConvertTo-Json -Depth 10

$resp = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/events-ingest" `
  -Method POST -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" -Body $body

$resp | ConvertTo-Json -Depth 10