. "$PSScriptRoot\tokens.ps1"

$batchId = (Get-Content "$PSScriptRoot\test-batch-id.txt" -Raw).Trim()

$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$token = $auth.access_token

$sims = @(
  @{ iccid = "8925402000000000001"; msisdn = "0722000001"; expiry_date = "01/2028" },
  @{ iccid = "8925402000000000002"; msisdn = "0722000002"; expiry_date = "01/2028" },
  @{ iccid = "8925402000000000003"; msisdn = "0722000003"; expiry_date = "02/2028" },
  @{ iccid = "8925402000000000004"; msisdn = "0722000004" },
  @{ iccid = "8925402000000000005" }
)

$body = @{
  workspace_id = $MAINAGENT1_WORKSPACE
  batch_id     = $batchId
  sims         = $sims
} | ConvertTo-Json -Depth 5

$resp = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/sims-bulk-add" `
  -Method POST -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" -Body $body

$resp | ConvertTo-Json -Depth 10