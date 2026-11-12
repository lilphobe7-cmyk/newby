. "$PSScriptRoot\tokens.ps1"

# ⚠️ REPLACE with subagent1's real UUID from the SQL query
$SUB_AGENT_ID = "e6988c40-b19c-43ed-a604-c8384d76d344"

$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$token = $auth.access_token

# Read batch ID from file
$batchId = (Get-Content "$PSScriptRoot\test-batch-id.txt" -Raw).Trim()
Write-Host "Using batch: $batchId" -ForegroundColor Cyan

# Fetch SIMs from that batch — URL is built separately to avoid parsing issues
$listUrl = "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/sims-list?workspace_id=$MAINAGENT1_WORKSPACE&batch_id=$batchId"
Write-Host "Fetching SIMs from: $listUrl" -ForegroundColor DarkGray

$sims = Invoke-RestMethod `
  -Uri $listUrl `
  -Method GET `
  -Headers @{ Authorization = "Bearer $token" }

$simIds = @($sims.sims | Select-Object -First 3 | ForEach-Object { $_.id })

if ($simIds.Count -eq 0) {
  Write-Host "No SIMs found in batch. Cannot create assignment." -ForegroundColor Red
  exit 1
}

Write-Host "Assigning $($simIds.Count) SIM(s)" -ForegroundColor Cyan

$body = @{
  workspace_id = $MAINAGENT1_WORKSPACE
  assigned_to  = $SUB_AGENT_ID
  sim_ids      = $simIds
  notes        = "Test assignment to sub-agent"
} | ConvertTo-Json -Depth 5

$resp = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/assignments-create" `
  -Method POST `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body $body

$resp | ConvertTo-Json -Depth 10

# Save for later tests
$resp.assignment.id | Out-File -FilePath "$PSScriptRoot\test-assignment-id.txt" -NoNewline -Encoding utf8
$SUB_AGENT_ID | Out-File -FilePath "$PSScriptRoot\test-subagent-id.txt" -NoNewline -Encoding utf8
Write-Host "`nAssignment ID saved" -ForegroundColor Yellow