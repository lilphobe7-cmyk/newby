. "$PSScriptRoot\tokens.ps1"

# ⚠️ REPLACE THIS with the Airtel network ID from the SQL query
$NETWORK_ID = "cf2c0818-327f-4b97-864d-bd3c0dc4b334"

$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$token = $auth.access_token

$create = @{
  workspace_id      = $MAINAGENT1_WORKSPACE
  network_id        = $NETWORK_ID
  reference         = "BATCH-001"
  supplier          = "Airtel Kenya"
  quantity_expected = 200
  notes             = "First test batch"
} | ConvertTo-Json

$resp = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/batches-create" `
  -Method POST -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" -Body $create

$resp | ConvertTo-Json -Depth 10

# Save the batch ID for later tests
$resp.batch.id | Out-File -FilePath "$PSScriptRoot\last-batch-id.txt" -NoNewline -Encoding utf8
Write-Host "`nBatch ID saved to last-batch-id.txt" -ForegroundColor Yellow