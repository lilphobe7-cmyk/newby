. "$PSScriptRoot\tokens.ps1"

$batchId = (Get-Content "$PSScriptRoot\last-batch-id.txt" -Raw).Trim()

$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$token = $auth.access_token

# First try WITHOUT force — should fail (we expected 200, scanned 0)
Write-Host "`n--- Attempt 1: Close without force (should be rejected) ---" -ForegroundColor Yellow

try {
  Invoke-RestMethod `
    -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/batches-close" `
    -Method POST -Headers @{ Authorization = "Bearer $token" } `
    -ContentType "application/json" `
    -Body (@{ batch_id = $batchId } | ConvertTo-Json)
} catch {
  Write-Host "Correctly rejected: $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Green
  $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
  Write-Host "Body: $($reader.ReadToEnd())"
}

# Now try WITH force and a note — should succeed
Write-Host "`n--- Attempt 2: Close with force and note (should succeed) ---" -ForegroundColor Yellow

$close = @{
  batch_id = $batchId
  force    = $true
  note     = "Test batch closed with 200 unaccounted SIMs"
} | ConvertTo-Json

$resp = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/batches-close" `
  -Method POST -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" -Body $close

$resp | ConvertTo-Json -Depth 10