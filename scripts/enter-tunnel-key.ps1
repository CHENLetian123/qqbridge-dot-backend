param([Parameter(Mandatory=$true)][ValidatePattern('^tunnel_[A-Za-z0-9_-]{8,100}$')][string]$TunnelId)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form=New-Object Windows.Forms.Form
$form.Text='GPTBot - Dot tunnel runtime key'
$form.TopMost=$true
$form.Size=New-Object Drawing.Size(660,300)
$form.StartPosition='CenterScreen'
$form.FormBorderStyle='FixedDialog'
$form.MaximizeBox=$false
$label=New-Object Windows.Forms.Label
$label.SetBounds(20,15,610,85)
$label.Text="Enter your OpenAI Platform tunnel runtime key locally.`r`nTunnel: $TunnelId`r`nThe key is hidden and kept in process memory, not written to disk.`r`nRequired principal permissions: Tunnels Read + Use."
$keyBox=New-Object Windows.Forms.TextBox
$keyBox.SetBounds(20,110,600,30)
$keyBox.UseSystemPasswordChar=$true
$button=New-Object Windows.Forms.Button
$button.SetBounds(20,155,150,35)
$button.Text='Verify and connect'
$status=New-Object Windows.Forms.Label
$status.SetBounds(20,205,600,40)
$status.Text='Create or obtain a runtime key from your OpenAI Platform account. Do not paste it in chat.'
$button.Add_Click({
    if(-not $keyBox.Text.Trim().StartsWith('sk-')){ $status.Text='Enter a valid OpenAI Platform key.'; return }
    $button.Enabled=$false
    $status.Text='Verifying tunnel access...'
    $form.Refresh()
    $oldRuntimeKey=[Environment]::GetEnvironmentVariable('CONTROL_PLANE_API_KEY','Process')
    try{
        $env:CONTROL_PLANE_API_KEY=$keyBox.Text.Trim()
        $keyBox.Clear()
        & (Join-Path $PSScriptRoot 'connect-tunnel.ps1') -TunnelId $TunnelId | Out-Null
        $status.Text='Tunnel connected. Return to ChatGPT Dot to verify tools and subscriptions.'
        $button.Text='Connected'
    }catch{
        $status.Text=$_.Exception.Message
        $button.Enabled=$true
    }finally{[Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY',$oldRuntimeKey,'Process')}
})
$form.Controls.AddRange(@($label,$keyBox,$button,$status))
$form.AcceptButton=$button
$form.Add_Shown({ $form.Show(); $form.Activate(); $keyBox.Focus() })
[void]$form.ShowDialog()
$keyBox.Clear()
$form.Dispose()
