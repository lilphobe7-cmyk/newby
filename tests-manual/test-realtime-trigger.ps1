. "$PSScriptRoot\tokens.ps1"

$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$token = $auth.access_token

# Create a fresh batch
$NETWORK_ID = "cf2c0818-327f-4b97-864d-bd3c0dc4b334"

$createBatch = @{
  workspace_id      = $MAINAGENT1_WORKSPACE
  network_id        = $NETWORK_ID
  reference         = "REALTIME-TEST-$(Get-Date -Format 'yyyyMMddHHmmss')"
  quantity_expected = 3
} | ConvertTo-Json

$batch = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/batches-create" `
  -Method POST -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" -Body $createBatch

$batchId = $batch.batch.id
Write-Host "Created batch: $batchId" -ForegroundColor Cyan

Start-Sleep -Seconds 1

# Add 3 SIMs to the batch
$sims = @(
  @{ iccid = "8925403000000000101"; msisdn = "0733000101" },
  @{ iccid = "8925403000000000102"; msisdn = "0733000102" },
  @{ iccid = "8925403000000000103"; msisdn = "0733000103" }
)

$bulk = @{
  workspace_id = $MAINAGENT1_WORKSPACE
  batch_id     = $batchId
  sims         = $sims
} | ConvertTo-Json -Depth 5

Write-Host "`nAdding 3 SIMs (this should trigger realtime events)..." -ForegroundColor Yellow
$resp = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/sims-bulk-add" `
  -Method POST -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" -Body $bulk

$resp | ConvertTo-Json -Depth 5

Write-Host "`nBatch ID saved to last-realtime-batch.txt" -ForegroundColor Cyan
$batchId | Out-File -FilePath "$PSScriptRoot\last-realtime-batch.txt" -NoNewline -Encoding utf8

# Also save SIM IDs
$simIds = @($resp.sims | ForEach-Object { $_.id })
$simIds -join "`n" | Out-File -FilePath "$PSScriptRoot\last-realtime-sim-ids.txt" -Encoding utf8

Write-Host "SIM IDs saved to last-realtime-sim-ids.txt" -ForegroundColor Cyan