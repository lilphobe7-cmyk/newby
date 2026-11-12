. "$PSScriptRoot\tokens.ps1"

$assignmentId = (Get-Content "$PSScriptRoot\test-assignment-id.txt" -Raw).Trim()

if (-not $assignmentId) {
  Write-Host "No assignment ID. Run test-assign-01-create.ps1 first." -ForegroundColor Red
  exit 1
}

Write-Host "Acknowledging: $assignmentId" -ForegroundColor Cyan

. "$PSScriptRoot\tokens.ps1"

$login = @{
  email    = $SUBAGENT4_EMAIL
  password = $SUBAGENT4_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$subToken = $auth.access_token

$body = @{
  assignment_id = $assignmentId
  notes         = "Received in good condition"
} | ConvertTo-Json

$resp = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/assignments-acknowledge" `
  -Method POST `
  -Headers @{ Authorization = "Bearer $subToken" } `
  -ContentType "application/json" `
  -Body $body

$resp | ConvertTo-Json -Depth 10