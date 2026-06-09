# TOTP 测试二维码生成说明

## 📋 测试 URL（可直接生成二维码）

### 1. 标准 SHA1 TOTP（默认参数）
```
otpauth://totp/GitHub:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub
```

### 2. SHA256 算法 TOTP
```
otpauth://totp/Google:user@gmail.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Google&algorithm=SHA256
```

### 3. SHA512 算法 TOTP
```
otpauth://totp/AWS:user@company.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Amazon%20AWS&algorithm=SHA512
```

### 4. 8位验证码 TOTP
```
otpauth://totp/Microsoft:user@outlook.com?secret=JBSWY3DPEHPK3PXP&issuer=Microsoft&digits=8
```

### 5. 60秒周期 TOTP
```
otpauth://totp/Steam:username?secret=JBSWY3DPEHPK3PXP&issuer=Steam&period=60
```

### 6. 组合参数 TOTP
```
otpauth://totp/Custom:admin?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=CustomService&algorithm=SHA256&digits=8&period=60
```

---

## 🔧 生成二维码

**在线工具**: https://www.the-qrcode-generator.com/

将上面的 URL 复制粘贴到输入框，生成二维码。

---

## 📱 Google Authenticator 批量迁移测试

**最佳方法**：使用真实的 Google Authenticator
1. 在 Google Authenticator 中添加 3-5 个测试账号
2. 点击右上角 "⋮" > "转移账号" > "导出账号"
3. 选择要导出的账号
4. 扫描生成的批量迁移二维码
5. 验证导入结果

---

**测试完成！现在可以用这些 URL 生成二维码测试扫码功能了。** 🎉
