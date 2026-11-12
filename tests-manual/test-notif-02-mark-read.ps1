. "$PSScriptRoot\tokens.ps1"

$NOTIFICATION_ID = "57f87ac3-122d-48eb-99ef-10bb5d1d2a3b"

$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$token = $auth.access_token

$body = @{ notification_id = $NOTIFICATION_ID } | ConvertTo-Json

$resp = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/notifications-mark-read" `
  -Method POST -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" -Body $body

$resp | ConvertTo-Json -Depth 10