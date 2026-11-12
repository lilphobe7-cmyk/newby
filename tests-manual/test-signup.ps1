$signup = @{
  email          = "mainagent3@example.com"
  password       = "Password1!"
  full_name      = "Main Agent Three"
  workspace_name = "Kisumu SIMs"
  business_name  = "Kisumu SIMs Ltd"
  phone          = "+254733445566"
} | ConvertTo-Json

$resp = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-main-agent-signup" `
  -Method POST `
  -ContentType "application/json" `
  -Body $signup

$resp | ConvertTo-Json -Depth 10