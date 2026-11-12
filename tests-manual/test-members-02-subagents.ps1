. "$PSScriptRoot\tokens.ps1"

$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$token = $auth.access_token

$resp = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/workspace-members-list?workspace_id=$MAINAGENT1_WORKSPACE&role=SUB_AGENT" `
  -Method GET -Headers @{ Authorization = "Bearer $token" }

$resp | ConvertTo-Json -Depth 10