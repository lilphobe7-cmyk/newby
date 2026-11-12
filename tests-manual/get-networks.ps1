. "$PSScriptRoot\tokens.ps1"

$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

Write-Host "Logged in as $($auth.user.email)" -ForegroundColor Green
Write-Host "`nNetworks (run this SQL to get IDs):" -ForegroundColor Yellow
Write-Host "SELECT id, code, display_name FROM networks;" -ForegroundColor Cyan