. "$PSScriptRoot\tokens.ps1"

$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$token = $auth.access_token

# Change the fee to 700 KES
$body = @{ fee_kes = 700 } | ConvertTo-Json

$resp = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/admin-set-fee" `
  -Method POST `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body $body

$resp | ConvertTo-Json -Depth 10