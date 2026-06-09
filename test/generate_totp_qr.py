#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TOTP 二维码生成器
用于测试 Android 扫码功能
"""

import qrcode
import base64
from urllib.parse import quote

def generate_standard_totp_qr(filename, label, secret, issuer="", algorithm="SHA1", digits=6, period=30):
    """生成标准 TOTP 二维码"""
    # 构建 otpauth URL
    url = f"otpauth://totp/{quote(label)}?secret={secret}"

    if issuer:
        url += f"&issuer={quote(issuer)}"
    if algorithm != "SHA1":
        url += f"&algorithm={algorithm}"
    if digits != 6:
        url += f"&digits={digits}"
    if period != 30:
        url += f"&period={period}"

    # 生成二维码
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_L,
        box_size=10,
        border=4,
    )
    qr.add_data(url)
    qr.make(fit=True)

    img = qr.make_image(fill_color="black", back_color="white")
    img.save(filename)
    print(f"✅ 生成: {filename}")
    print(f"   URL: {url}")
    print()

def generate_google_migration_qr(filename, accounts):
    """
    生成 Google Authenticator 批量迁移二维码

    accounts: list of dict with keys: name, secret, issuer, algorithm, digits, type
    """
    # Google Authenticator 使用 Protocol Buffers 格式
    # 这里我们生成一个模拟的 base64 编码数据

    # 简化版：只生成 URL 格式（实际需要 protobuf 库）
    # otpauth-migration://offline?data=<base64_encoded_protobuf>

    # 注意：这是简化版本，实际的 Google Authenticator 迁移格式需要使用 protobuf
    # 这里我们生成一个说明文件

    print(f"⚠️  Google Authenticator 迁移格式需要 protobuf")
    print(f"   账号列表:")
    for i, account in enumerate(accounts, 1):
        print(f"   {i}. {account['issuer']}: {account['name']}")
    print()

    # 生成提示二维码
    note = "Google Authenticator migration format requires protobuf encoding.\n"
    note += f"Accounts to migrate: {len(accounts)}\n"
    for account in accounts:
        note += f"- {account['issuer']}: {account['name']}\n"

    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_L,
        box_size=10,
        border=4,
    )
    qr.add_data(note)
    qr.make(fit=True)

    img = qr.make_image(fill_color="black", back_color="white")
    img.save(filename)
    print(f"ℹ️  生成说明图: {filename}")
    print()

def main():
    print("=" * 60)
    print("TOTP 测试二维码生成器")
    print("=" * 60)
    print()

    # 1. 标准 SHA1 TOTP (默认参数)
    generate_standard_totp_qr(
        "totp_sha1_default.png",
        label="GitHub:user@example.com",
        secret="JBSWY3DPEHPK3PXP",
        issuer="GitHub"
    )

    # 2. SHA256 算法 TOTP
    generate_standard_totp_qr(
        "totp_sha256.png",
        label="Google:user@gmail.com",
        secret="JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
        issuer="Google",
        algorithm="SHA256"
    )

    # 3. SHA512 算法 TOTP
    generate_standard_totp_qr(
        "totp_sha512.png",
        label="AWS:user@company.com",
        secret="JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
        issuer="Amazon AWS",
        algorithm="SHA512"
    )

    # 4. 8 位验证码
    generate_standard_totp_qr(
        "totp_8digits.png",
        label="Microsoft:user@outlook.com",
        secret="JBSWY3DPEHPK3PXP",
        issuer="Microsoft",
        digits=8
    )

    # 5. 60 秒周期
    generate_standard_totp_qr(
        "totp_60sec.png",
        label="Steam:username",
        secret="JBSWY3DPEHPK3PXP",
        issuer="Steam",
        period=60
    )

    # 6. 组合：SHA256 + 8位 + 60秒
    generate_standard_totp_qr(
        "totp_combined.png",
        label="Custom:admin",
        secret="JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
        issuer="CustomService",
        algorithm="SHA256",
        digits=8,
        period=60
    )

    # 7. 模拟 Google Authenticator 批量迁移
    google_accounts = [
        {
            "name": "user1@gmail.com",
            "secret": "JBSWY3DPEHPK3PXP",
            "issuer": "Google",
            "algorithm": "SHA1",
            "digits": 6,
            "type": "totp"
        },
        {
            "name": "user@github.com",
            "secret": "ABCDEFGHIJKLMNOP",
            "issuer": "GitHub",
            "algorithm": "SHA1",
            "digits": 6,
            "type": "totp"
        },
        {
            "name": "admin@aws.com",
            "secret": "QRSTUVWXYZ234567",
            "issuer": "AWS",
            "algorithm": "SHA256",
            "digits": 6,
            "type": "totp"
        }
    ]

    generate_google_migration_qr("google_migration_multi.png", google_accounts)

    print("=" * 60)
    print("✅ 所有测试二维码生成完成！")
    print("=" * 60)
    print()
    print("📝 测试清单：")
    print("1. totp_sha1_default.png  - 标准 SHA1, 6位, 30秒")
    print("2. totp_sha256.png        - SHA256 算法")
    print("3. totp_sha512.png        - SHA512 算法")
    print("4. totp_8digits.png       - 8位验证码")
    print("5. totp_60sec.png         - 60秒周期")
    print("6. totp_combined.png      - SHA256 + 8位 + 60秒")
    print("7. google_migration_multi.png - 批量迁移说明")
    print()

if __name__ == "__main__":
    main()
