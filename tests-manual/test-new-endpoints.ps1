. "$PSScriptRoot\tokens.ps1"

$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" -Method POST -ContentType "application/json" -Body $login

$token = $auth.access_token

Write-Host "=== Test 1: sims-delete ===" -ForegroundColor Cyan

$sims = Invoke-RestMethod -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/sims-list?workspace_id=$MAINAGENT1_WORKSPACE&status=AWAITING_ASSIGNMENT&limit=1" -Method GET -Headers @{ Authorization = "Bearer $token" }

if ($sims.sims.Count -gt 0) {
  $delBody = @{ sim_id = $sims.sims[0].id; reason = "Test delete" } | ConvertTo-Json
  try {
    $r = Invoke-RestMethod -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/sims-delete" -Method POST -Headers @{ Authorization = "Bearer $token" } -ContentType "application/json" -Body $delBody
    Write-Host "sims-delete: OK" -ForegroundColor Green
    $r | ConvertTo-Json -Depth 5
  } catch {
    Write-Host "sims-delete: FAILED - $($_.Exception.Message)" -ForegroundColor Red
  }
} else {
  Write-Host "No unassigned SIMs to test" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Test 2: batches-delete ===" -ForegroundColor Cyan

$batches = Invoke-RestMethod -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/batches-list?workspace_id=$MAINAGENT1_WORKSPACE&status=OPEN&limit=5" -Method GET -Headers @{ Authorization = "Bearer $token" }

if ($batches.batches.Count -gt 0) {
  $bdBody = @{ batch_id = $batches.batches[0].id; reason = "Test batch delete" } | ConvertTo-Json
  try {
    $r = Invoke-RestMethod -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/batches-delete" -Method POST -Headers @{ Authorization = "Bearer $token" } -ContentType "application/json" -Body $bdBody
    Write-Host "batches-delete: OK" -ForegroundColor Green
    $r | ConvertTo-Json -Depth 5
  } catch {
    Write-Host "batches-delete: FAILED - $($_.Exception.Message)" -ForegroundColor Red
  }
} else {
  Write-Host "No open batches to test" -ForegroundColor Yellow
}
