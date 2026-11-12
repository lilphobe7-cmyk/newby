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

$detail = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/batches-detail?batch_id=$batchId" `
  -Method GET `
  -Headers @{ Authorization = "Bearer $token" }

$detail | ConvertTo-Json -Depth 10