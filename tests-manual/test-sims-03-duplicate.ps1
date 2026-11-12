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
  workspace_id = $MAINAGENT1_WORKSPACE
  batch_id     = $batchId
  iccid        = "8925401234567890123"  # same as before
} | ConvertTo-Json

try {
  Invoke-RestMethod `
    -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/sims-add" `
    -Method POST -Headers @{ Authorization = "Bearer $token" } `
    -ContentType "application/json" -Body $add

  Write-Host "ERROR: Duplicate allowed!" -ForegroundColor Red
} catch {
  Write-Host "Correctly rejected" -ForegroundColor Green
  Write-Host "Status: $($_.Exception.Response.StatusCode.value__)"
  $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
  Write-Host "Body: $($reader.ReadToEnd())"
}