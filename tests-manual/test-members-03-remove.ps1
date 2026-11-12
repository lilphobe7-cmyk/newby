. "$PSScriptRoot\tokens.ps1"

# subagent1 = adeafd36-2493-4466-b613-9560e843a242
$TARGET_USER_ID = "adeafd36-2493-4466-b613-9560e843a242"

$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$token = $auth.access_token

$body = @{
  workspace_id = $MAINAGENT1_WORKSPACE
  user_id      = $TARGET_USER_ID
  reason       = "Test removal via API"
  reassign_sims = $true
} | ConvertTo-Json

$resp = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/workspace-member-remove" `
  -Method POST -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" -Body $body

$resp | ConvertTo-Json -Depth 10