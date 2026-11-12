. "$PSScriptRoot\tokens.ps1"

$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$token = $auth.access_token

$list = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/assignments-list?workspace_id=$MAINAGENT1_WORKSPACE" `
  -Method GET `
  -Headers @{ Authorization = "Bearer $token" }

$list | ConvertTo-Json -Depth 10