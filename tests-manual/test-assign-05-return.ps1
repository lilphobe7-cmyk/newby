. "$PSScriptRoot\tokens.ps1"

. "$PSScriptRoot\tokens.ps1"

$login = @{
  email    = $SUBAGENT4_EMAIL
  password = $SUBAGENT4_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$subToken = $auth.access_token

# Fetch own SIMs
$listUrl = "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/sims-list?workspace_id=$MAINAGENT1_WORKSPACE"
$list = Invoke-RestMethod `
  -Uri $listUrl `
  -Method GET `
  -Headers @{ Authorization = "Bearer $subToken" }

$simIds = @($list.sims | Select-Object -First 2 | ForEach-Object { $_.id })

if ($simIds.Count -eq 0) {
  Write-Host "No SIMs assigned. Cannot return." -ForegroundColor Red
  exit 1
}

Write-Host "Returning $($simIds.Count) SIM(s)" -ForegroundColor Cyan

$body = @{
  sim_ids = $simIds
  reason  = "Customer not found"
  notes   = "Returning to main agent"
} | ConvertTo-Json -Depth 5

$resp = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/assignments-return" `
  -Method POST `
  -Headers @{ Authorization = "Bearer $subToken" } `
  -ContentType "application/json" `
  -Body $body

$resp | ConvertTo-Json -Depth 10