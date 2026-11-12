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

$add = @{
  workspace_id     = $MAINAGENT1_WORKSPACE
  batch_id         = $batchId
  iccid            = "8925401234567890123"
  msisdn           = "0712345678"
  expiry_date      = "12/2027"
  scan_method      = "MANUAL_ENTRY"
  scan_confidence  = @{ iccid = 0.99; msisdn = 0.95; expiry = 0.85 }
} | ConvertTo-Json -Depth 5

$resp = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/sims-add" `
  -Method POST -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" -Body $add

$resp | ConvertTo-Json -Depth 10