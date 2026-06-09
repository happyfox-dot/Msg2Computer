#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TOTP 算法测试和验证
测试不同算法生成的验证码是否正确
"""

import hmac
import hashlib
import base64
import struct
import time
from typing import Tuple

def base32_decode(secret: str) -> bytes:
    """Base32 解码"""
    # 添加 padding
    missing_padding = len(secret) % 8
    if missing_padding:
        secret += '=' * (8 - missing_padding)
    return base64.b32decode(secret.upper())

def generate_totp(
    secret: str,
    timestamp: int = None,
    algorithm: str = 'SHA1',
    digits: int = 6,
    period: int = 30
) -> Tuple[str, int]:
    """
    生成 TOTP 验证码

    返回: (验证码, 剩余秒数)
    """
    if timestamp is None:
        timestamp = int(time.time())

    # 计算时间步长
    counter = timestamp // period

    # 转换为字节
    counter_bytes = struct.pack('>Q', counter)

    # Base32 解码密钥
    key = base32_decode(secret)

    # 选择算法
    if algorithm.upper() == 'SHA256':
        hash_func = hashlib.sha256
    elif algorithm.upper() == 'SHA512':
        hash_func = hashlib.sha512
    else:
        hash_func = hashlib.sha1

    # HMAC
    hmac_hash = hmac.new(key, counter_bytes, hash_func).digest()

    # 动态截断
    offset = hmac_hash[-1] & 0x0f
    code = struct.unpack('>I', hmac_hash[offset:offset+4])[0] & 0x7fffffff
    code = code % (10 ** digits)

    # 格式化
    code_str = str(code).zfill(digits)

    # 计算剩余秒数
    remaining = period - (timestamp % period)

    return code_str, remaining

def test_totp_algorithms():
    """测试各种 TOTP 算法"""
    print("=" * 70)
    print("TOTP 算法测试")
    print("=" * 70)
    print()

    test_cases = [
        {
            "name": "标准 SHA1（GitHub）",
            "secret": "JBSWY3DPEHPK3PXP",
            "algorithm": "SHA1",
            "digits": 6,
            "period": 30
        },
        {
            "name": "SHA256（Google）",
            "secret": "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
            "algorithm": "SHA256",
            "digits": 6,
            "period": 30
        },
        {
            "name": "SHA512（AWS）",
            "secret": "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
            "algorithm": "SHA512",
            "digits": 6,
            "period": 30
        },
        {
            "name": "8位验证码（Microsoft）",
            "secret": "JBSWY3DPEHPK3PXP",
            "algorithm": "SHA1",
            "digits": 8,
            "period": 30
        },
        {
            "name": "60秒周期（Steam）",
            "secret": "JBSWY3DPEHPK3PXP",
            "algorithm": "SHA1",
            "digits": 6,
            "period": 60
        },
        {
            "name": "组合参数（Custom）",
            "secret": "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
            "algorithm": "SHA256",
            "digits": 8,
            "period": 60
        }
    ]

    current_time = int(time.time())

    for i, test in enumerate(test_cases, 1):
        print(f"{i}. {test['name']}")
        print(f"   密钥: {test['secret']}")
        print(f"   算法: {test['algorithm']}, 位数: {test['digits']}, 周期: {test['period']}秒")

        code, remaining = generate_totp(
            test['secret'],
            current_time,
            test['algorithm'],
            test['digits'],
            test['period']
        )

        print(f"   [OK] 当前验证码: {code}")
        print(f"   [>] 剩余时间: {remaining}秒")
        print()

def compare_algorithms():
    """对比不同算法在相同密钥下的输出"""
    print("=" * 70)
    print("算法对比测试（相同密钥、不同算法）")
    print("=" * 70)
    print()

    secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
    current_time = int(time.time())

    print(f"测试密钥: {secret}")
    print(f"当前时间: {current_time}")
    print()

    algorithms = ['SHA1', 'SHA256', 'SHA512']

    for algo in algorithms:
        code, remaining = generate_totp(secret, current_time, algo, 6, 30)
        print(f"{algo:8s} → {code} (剩余 {remaining}秒)")

    print()
    print("[NOTE] 说明：不同算法生成的验证码应该不同！")
    print("   如果 Android 端用 SHA1 算法计算 SHA256 的密钥，")
    print("   那么验证码会与桌面端不一致。")
    print()

def test_edge_cases():
    """测试边界情况"""
    print("=" * 70)
    print("边界测试")
    print("=" * 70)
    print()

    secret = "JBSWY3DPEHPK3PXP"

    # 测试不同时间点
    test_times = [
        ("周期开始", 0),
        ("周期中间", 15),
        ("周期末尾", 29),
    ]

    base_time = (int(time.time()) // 30) * 30  # 当前周期的起始时间

    for desc, offset in test_times:
        test_time = base_time + offset
        code, remaining = generate_totp(secret, test_time, 'SHA1', 6, 30)
        print(f"{desc:12s} (偏移 {offset:2d}秒) → {code} (剩余 {remaining:2d}秒)")

    print()

def main():
    """主函数"""
    test_totp_algorithms()
    compare_algorithms()
    test_edge_cases()

    print("=" * 70)
    print("[DONE] 测试完成！")
    print("=" * 70)
    print()
    print("[NEXT] 接下来：")
    print("1. 将测试 URL 生成二维码")
    print("2. 用手机扫描")
    print("3. 对比手机端显示的验证码是否与上面一致")
    print()
    print("[LINK] 在线验证工具：")
    print("   https://totp.danhersam.com/")
    print("   https://www.verifyr.com/en/otp/check")
    print()

if __name__ == "__main__":
    main()
