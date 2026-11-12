. "$PSScriptRoot\tokens.ps1"

$batchId = (Get-Content "$PSScriptRoot\last-batch-id.txt" -Raw).Trim()

if (-not $batchId) {
  Write-Host "No batch ID found. Run test-batch-create.ps1 first." -ForegroundColor Red
  exit 1
}

Write-Host "Fetching batch: $batchId" -ForegroundColor Cyan

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