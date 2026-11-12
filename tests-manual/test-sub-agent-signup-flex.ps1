. "$PSScriptRoot\tokens.ps1"

# Login as main agent
$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" -Method POST -ContentType "application/json" -Body $login
$token = $auth.access_token

# Create a fresh invitation
$createBody = @{ workspace_id = $MAINAGENT1_WORKSPACE; ttl_hours = 24 } | ConvertTo-Json
$inv = Invoke-RestMethod -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/invitations-create" -Method POST -Headers @{ Authorization = "Bearer $token" } -ContentType "application/json" -Body $createBody

Write-Host "`nInvitation created:" -ForegroundColor Cyan
Write-Host "  Raw token (what the sub-agent pastes): $($inv.token)" -ForegroundColor Yellow
Write-Host "  Full share link: $($inv.web_url)" -ForegroundColor Yellow

# Now sign up using 'invite_code' field (what the app currently sends)
$signupBody = @{
  invite_code = $inv.token
  email       = "testsub1@example.com"
  password    = "Password1!"
  full_name   = "Test Sub Agent"
} | ConvertTo-Json

Write-Host "`nAttempting sub-agent signup with 'invite_code' field..." -ForegroundColor Cyan
try {
  $resp = Invoke-RestMethod -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-sub-agent-signup" -Method POST -ContentType "application/json" -Body $signupBody
  Write-Host "SUCCESS!" -ForegroundColor Green
  $resp | ConvertTo-Json -Depth 5
} catch {
  Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
}
