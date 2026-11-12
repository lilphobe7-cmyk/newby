. "$PSScriptRoot\tokens.ps1"

# Login as mainagent1 to get a fresh token
$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$token = $auth.access_token
Write-Host "Logged in as $($auth.user.email)" -ForegroundColor Green

# Create an invitation
$create = @{
  workspace_id = $MAINAGENT1_WORKSPACE
  ttl_hours    = 24
} | ConvertTo-Json

$inv = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/invitations-create" `
  -Method POST `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body $create

Write-Host "`nInvitation created:" -ForegroundColor Cyan
$inv | ConvertTo-Json -Depth 10

# Save the raw token for later tests
$inv.token | Out-File -FilePath "$PSScriptRoot\last-invitation-token.txt" -NoNewline -Encoding utf8
$inv.invitation_id | Out-File -FilePath "$PSScriptRoot\last-invitation-id.txt" -NoNewline -Encoding utf8

Write-Host "`nToken saved to tests-manual\last-invitation-token.txt" -ForegroundColor Yellow