#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Google Authenticator 迁移格式生成器
使用 protobuf 生成真实的批量迁移二维码
"""

import base64
from urllib.parse import quote

def generate_migration_payload(accounts):
    """
    生成 Google Authenticator 迁移 Payload

    注意：这需要 google-auth-migration.proto 编译后的 Python 模块
    简化版本，仅展示结构
    """

    # Google Authenticator Migration 格式（简化说明）
    # message MigrationPayload {
    #   repeated OtpParameters otp_parameters = 1;
    #   int32 version = 2;
    #   int32 batch_size = 3;
    #   int32 batch_index = 4;
    #   int32 batch_id = 5;
    # }

    # message OtpParameters {
    #   bytes secret = 1;
    #   string name = 2;
    #   string issuer = 3;
    #   Algorithm algorithm = 4;  // SHA1=1, SHA256=2, SHA512=3
    #   DigitCount digits = 5;     // SIX=1, EIGHT=2
    #   OtpType type = 6;          // HOTP=1, TOTP=2
    #   int64 counter = 7;
    # }

    print("⚠️  生成真实的 Google Authenticator 迁移二维码需要以下步骤：")
    print()
    print("1. 安装 protobuf:")
    print("   pip install protobuf")
    print()
    print("2. 下载 .proto 文件:")
    print("   https://github.com/google/google-authenticator-android")
    print("   找到 migration.proto")
    print()
    print("3. 编译 proto:")
    print("   protoc --python_out=. migration.proto")
    print()
    print("4. 使用编译后的模块生成 payload")
    print()

    # 生成示例 URL（不含真实 payload）
    example_data = base64.b64encode(b"EXAMPLE_PROTOBUF_DATA").decode()
    url = f"otpauth-migration://offline?data={quote(example_data)}"

    print(f"示例 URL 格式:")
    print(f"{url}")
    print()
    print(f"📝 测试账号列表:")
    for i, acc in enumerate(accounts, 1):
        print(f"{i}. {acc['issuer']}: {acc['name']}")
        print(f"   Secret: {acc['secret']}")
        print(f"   Algorithm: {acc['algorithm']}")
        print(f"   Digits: {acc['digits']}")
        print()

# 测试数据
test_accounts = [
    {
        "name": "user1@gmail.com",
        "secret": "JBSWY3DPEHPK3PXP",
        "issuer": "Google",
        "algorithm": "SHA1",
        "digits": 6,
    },
    {
        "name": "user@github.com",
        "secret": "ABCDEFGHIJKLMNOP",
        "issuer": "GitHub",
        "algorithm": "SHA1",
        "digits": 6,
    },
    {
        "name": "admin@aws.com",
        "secret": "QRSTUVWXYZ234567",
        "issuer": "AWS",
        "algorithm": "SHA256",
        "digits": 6,
    }
]

print("=" * 60)
print("Google Authenticator 批量迁移格式说明")
print("=" * 60)
print()

generate_migration_payload(test_accounts)

print("=" * 60)
print("🔧 替代方案：使用真实的 Google Authenticator")
print("=" * 60)
print()
print("1. 在 Google Authenticator 中添加测试账号")
print("2. 点击右上角 '...' > '转移账号' > '导出账号'")
print("3. 选择要导出的账号")
print("4. 使用生成的二维码测试")
print()
print("✅ 这是最可靠的测试方法！")
