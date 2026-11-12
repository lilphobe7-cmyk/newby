. "$PSScriptRoot\tokens.ps1"

$batchId = (Get-Content "$PSScriptRoot\test-batch-id.txt" -Raw).Trim()

$login = @{
  email    = "subagent1@example.com"
  password = "Password1"
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$subToken = $auth.access_token

$add = @{
  workspace_id = $MAINAGENT1_WORKSPACE
  batch_id     = $batchId
  iccid        = "8925409999999999999"
} | ConvertTo-Json

try {
  Invoke-RestMethod `
    -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/sims-add" `
    -Method POST -Headers @{ Authorization = "Bearer $subToken" } `
    -ContentType "application/json" -Body $add

  Write-Host "ERROR: Sub-agent was allowed to add SIMs!" -ForegroundColor Red
} catch {
  Write-Host "Correctly blocked" -ForegroundColor Green
  Write-Host "Status: $($_.Exception.Response.StatusCode.value__)"
  $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
  Write-Host "Body: $($reader.ReadToEnd())"
}