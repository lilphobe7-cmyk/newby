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

$list = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/sims-list?workspace_id=$MAINAGENT1_WORKSPACE&limit=50" `
  -Method GET `
  -Headers @{ Authorization = "Bearer $subToken" }

$list | ConvertTo-Json -Depth 10