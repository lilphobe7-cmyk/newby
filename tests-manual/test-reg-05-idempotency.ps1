. "$PSScriptRoot\tokens.ps1"

$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$token = $auth.access_token

# Fixed event_id so we can submit twice
$FIXED_EVENT_ID = "11111111-2222-3333-4444-555555555555"
$SIM_ID = "97019c78-3587-4f19-b221-6210888887ef"

$events = @(
  @{
    event_id         = $FIXED_EVENT_ID
    sim_id           = $SIM_ID
    action           = "REGISTRATION_REPORTED"
    device_timestamp = (Get-Date).ToUniversalTime().ToString("o")
    payload          = @{
      phone_number = "0722999999"
      notes        = "Idempotency test"
    }
  }
)

$body = @{ events = $events } | ConvertTo-Json -Depth 10

Write-Host ""
Write-Host "--- Submission 1 (should accept) ---" -ForegroundColor Cyan
$resp1 = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/events-ingest" `
  -Method POST -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" -Body $body
$resp1 | ConvertTo-Json -Depth 10

Write-Host ""
Write-Host "--- Submission 2 (same event_id, should be duplicate) ---" -ForegroundColor Yellow
$resp2 = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/events-ingest" `
  -Method POST -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" -Body $body
$resp2 | ConvertTo-Json -Depth 10