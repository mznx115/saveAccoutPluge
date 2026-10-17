# 生成插件图标（纯 System.Drawing，无外部依赖）
# 用法: pwsh -File tools/make-icons.ps1

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

foreach ($size in 16, 32, 48, 128) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)

  $s = [float]$size
  # 背景圆角方块
  $bg = New-RoundedPath 0 0 $s $s ($s * 0.22)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($size, $size)),
    [System.Drawing.Color]::FromArgb(255, 59, 130, 246),
    [System.Drawing.Color]::FromArgb(255, 29, 78, 216))
  $g.FillPath($brush, $bg)

  # 白色锁：锁体
  $bodyW = $s * 0.46
  $bodyH = $s * 0.36
  $bodyX = ($s - $bodyW) / 2
  $bodyY = $s * 0.46
  $body = New-RoundedPath $bodyX $bodyY $bodyW $bodyH ($s * 0.08)
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $g.FillPath($white, $body)

  # 白色锁：锁梁（圆环的一半）
  $shackleW = $s * 0.34
  $shackleH = $s * 0.34
  $shackleX = ($s - $shackleW) / 2
  $shackleY = $s * 0.22
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([float]([Math]::Max(1.0, $s * 0.09)))
  $pen.StartCap = 'Round'
  $pen.EndCap = 'Round'
  $g.DrawArc($pen, $shackleX, $shackleY, $shackleW, $shackleH, 180, 180)

  $bmp.Save((Join-Path $outDir "icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)

  $pen.Dispose(); $white.Dispose(); $brush.Dispose(); $body.Dispose(); $bg.Dispose(); $g.Dispose(); $bmp.Dispose()
  Write-Host "generated icon$size.png"
}
