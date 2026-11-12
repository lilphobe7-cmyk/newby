. "$PSScriptRoot\tokens.ps1"

$NETWORK_ID = "cf2c0818-327f-4b97-864d-bd3c0dc4b334"

$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$token = $auth.access_token

# Try to create a batch with the SAME reference (BATCH-001)
$create = @{
  workspace_id      = $MAINAGENT1_WORKSPACE
  network_id        = $NETWORK_ID
  reference         = "BATCH-001"
  quantity_expected = 100
} | ConvertTo-Json

try {
  Invoke-RestMethod `
    -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/batches-create" `
    -Method POST -Headers @{ Authorization = "Bearer $token" } `
    -ContentType "application/json" -Body $create

  Write-Host "ERROR: Duplicate was allowed!" -ForegroundColor Red
} catch {
  Write-Host "Correctly rejected" -ForegroundColor Green
  Write-Host "Status: $($_.Exception.Response.StatusCode.value__)"
  $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
  Write-Host "Body: $($reader.ReadToEnd())"
}