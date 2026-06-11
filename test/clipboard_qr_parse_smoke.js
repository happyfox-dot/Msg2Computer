const { app, clipboard, nativeImage } = require('electron')
const QRCode = require('../desktop/node_modules/qrcode')
const parser = require('../desktop/src/qrCodeParser')

app.whenReady().then(async () => {
  try {
    const uri = 'otpauth://totp/TestIssuer:test@example.com?secret=JBSWY3DPEHPK3PXP&issuer=TestIssuer&algorithm=SHA1&digits=6&period=30'
    const dataUrl = await QRCode.toDataURL(uri, { width: 320, margin: 2 })
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) {
      throw new Error('Failed to generate QR image')
    }

    clipboard.writeImage(image)
    const clipboardImage = clipboard.readImage()
    const result = await parser.parseImage(clipboardImage)
    console.log(JSON.stringify(result, null, 2))
    app.exit(result?.type === 'standard-totp' ? 0 : 1)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
