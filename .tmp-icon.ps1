Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('C:\Users\Ilya\PycharmProjects\Kripl-Studio\apps\desktop\build\icon.png')
$bmp = New-Object System.Drawing.Bitmap 32,32
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = 'HighQualityBicubic'
$g.DrawImage($src, 0, 0, 32, 32)
$g.Dispose()
$src.Dispose()
New-Item -ItemType Directory -Force 'C:\Users\Ilya\PycharmProjects\Kripl-Studio\apps\desktop\src\renderer\src\assets' | Out-Null
$bmp.Save('C:\Users\Ilya\PycharmProjects\Kripl-Studio\apps\desktop\src\renderer\src\assets\kripl-icon.png', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output OK
