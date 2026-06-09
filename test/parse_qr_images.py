#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
二维码解析工具
解析 Google Authenticator 导出的二维码
"""

import sys
from PIL import Image

try:
    from pyzbar.pyzbar import decode
except ImportError:
    print("错误：需要安装 pyzbar 库")
    print("请运行：pip install pyzbar pillow")
    sys.exit(1)

import base64
from urllib.parse import unquote

def parse_qr_image(image_path):
    """解析二维码图片"""
    print(f"\n=== 解析二维码: {image_path} ===")

    try:
        # 打开图片
        img = Image.open(image_path)
        print(f"图片尺寸: {img.size}")

        # 解码二维码
        decoded_objects = decode(img)

        if not decoded_objects:
            print("[X] 未找到二维码")
            return None

        print(f"[OK] 找到 {len(decoded_objects)} 个二维码\n")

        results = []
        for i, obj in enumerate(decoded_objects, 1):
            data = obj.data.decode('utf-8')
            print(f"二维码 {i}:")
            print(f"  类型: {obj.type}")
            print(f"  原始数据长度: {len(data)} 字符")
            print(f"  前100字符: {data[:100]}")

            if data.startswith("otpauth-migration://"):
                print(f"  [OK] 这是 Google Authenticator 批量迁移格式")
                parse_migration_url(data)
            elif data.startswith("otpauth://"):
                print(f"  [OK] 这是标准 TOTP 格式")
                parse_standard_totp(data)
            else:
                print(f"  [!] 未知格式")

            print()
            results.append(data)

        return results

    except Exception as e:
        print(f"[X] 解析失败: {e}")
        import traceback
        traceback.print_exc()
        return None

def parse_migration_url(url):
    """解析 Google Authenticator 迁移 URL"""
    try:
        # 提取 data 参数
        if "data=" not in url:
            print("  [X] 缺少 data 参数")
            return

        data_start = url.index("data=") + 5
        data_end = url.find("&", data_start)
        if data_end == -1:
            data_param = url[data_start:]
        else:
            data_param = url[data_start:data_end]

        # URL 解码
        data_param = unquote(data_param)
        print(f"  Data 参数长度: {len(data_param)}")

        # Base64 解码
        try:
            protobuf_data = base64.b64decode(data_param)
            print(f"  Protobuf 数据长度: {len(protobuf_data)} 字节")
            print(f"  前20字节: {protobuf_data[:20].hex()}")

            # 简单的 protobuf 解析提示
            print(f"  ")
            print(f"  [i] 这是 Protobuf 编码的数据，包含:")
            print(f"     - 账号名称")
            print(f"     - Secret 密钥")
            print(f"     - 算法（SHA1/SHA256/SHA512）")
            print(f"     - 位数（6/8）")
            print(f"     - 类型（TOTP/HOTP）")

        except Exception as e:
            print(f"  [X] Base64 解码失败: {e}")

    except Exception as e:
        print(f"  [X] 解析迁移 URL 失败: {e}")

def parse_standard_totp(url):
    """解析标准 TOTP URL"""
    try:
        from urllib.parse import urlparse, parse_qs

        parsed = urlparse(url)
        print(f"  Scheme: {parsed.scheme}")
        print(f"  Host: {parsed.netloc}")
        print(f"  Path: {parsed.path}")

        # 解析查询参数
        params = parse_qs(parsed.query)

        if 'secret' in params:
            secret = params['secret'][0]
            print(f"  Secret: {secret[:10]}... (长度: {len(secret)})")

        if 'issuer' in params:
            print(f"  Issuer: {params['issuer'][0]}")

        if 'algorithm' in params:
            print(f"  Algorithm: {params['algorithm'][0]}")

        if 'digits' in params:
            print(f"  Digits: {params['digits'][0]}")

        if 'period' in params:
            print(f"  Period: {params['period'][0]}")

    except Exception as e:
        print(f"  [X] 解析标准 TOTP 失败: {e}")

def main():
    import os

    print("=" * 70)
    print("Google Authenticator 二维码解析器")
    print("=" * 70)

    test_dir = "D:/test/google_auth"

    if not os.path.exists(test_dir):
        print(f"[X] 目录不存在: {test_dir}")
        return

    # 获取所有图片文件
    image_files = [f for f in os.listdir(test_dir)
                   if f.lower().endswith(('.jpg', '.jpeg', '.png'))]

    print(f"\n找到 {len(image_files)} 个图片文件")

    for image_file in image_files:
        image_path = os.path.join(test_dir, image_file)
        parse_qr_image(image_path)

    print("=" * 70)
    print("[DONE] 解析完成！")
    print("=" * 70)

if __name__ == "__main__":
    main()
