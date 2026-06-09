#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
详细解析 Google Authenticator 迁移 Protobuf 数据
"""

import sys
import base64
from urllib.parse import unquote
import struct

def read_varint(data, offset):
    """读取 varint 编码的整数"""
    result = 0
    shift = 0
    while offset < len(data):
        byte = data[offset]
        offset += 1
        result |= (byte & 0x7F) << shift
        if (byte & 0x80) == 0:
            return result, offset
        shift += 7
    return result, offset

def parse_protobuf_field(data, offset):
    """解析 protobuf 字段"""
    if offset >= len(data):
        return None, offset

    tag, offset = read_varint(data, offset)
    field_number = tag >> 3
    wire_type = tag & 0x07

    if wire_type == 0:  # Varint
        value, offset = read_varint(data, offset)
        return ('varint', field_number, value), offset
    elif wire_type == 2:  # Length-delimited
        length, offset = read_varint(data, offset)
        value = data[offset:offset+length]
        offset += length
        return ('bytes', field_number, value), offset
    else:
        return None, offset

def bytes_to_base32(data):
    """将字节数据转换为 Base32 编码"""
    import base64
    return base64.b32encode(data).decode('ascii').rstrip('=')

def parse_otp_parameters(data):
    """解析单个 OTP 参数"""
    offset = 0
    account = {
        'secret': None,
        'name': None,
        'issuer': None,
        'algorithm': 'SHA1',
        'digits': 6,
        'type': 'TOTP',
        'counter': 0
    }

    while offset < len(data):
        field, new_offset = parse_protobuf_field(data, offset)
        if field is None:
            break
        offset = new_offset

        wire_type, field_num, value = field

        if field_num == 1:  # secret (bytes)
            account['secret'] = value
            account['secret_base32'] = bytes_to_base32(value)
        elif field_num == 2:  # name (string)
            account['name'] = value.decode('utf-8', errors='ignore')
        elif field_num == 3:  # issuer (string)
            account['issuer'] = value.decode('utf-8', errors='ignore')
        elif field_num == 4:  # algorithm (varint)
            algo_map = {0: 'UNSPECIFIED', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5'}
            account['algorithm'] = algo_map.get(value, f'UNKNOWN({value})')
        elif field_num == 5:  # digits (varint)
            digits_map = {0: 'UNSPECIFIED', 1: 6, 2: 8}
            account['digits'] = digits_map.get(value, value)
        elif field_num == 6:  # type (varint)
            type_map = {0: 'UNSPECIFIED', 1: 'HOTP', 2: 'TOTP'}
            account['type'] = type_map.get(value, f'UNKNOWN({value})')
        elif field_num == 7:  # counter (varint)
            account['counter'] = value

    return account

def parse_migration_payload(data):
    """解析完整的迁移 Payload"""
    offset = 0
    accounts = []
    metadata = {
        'version': None,
        'batch_size': None,
        'batch_index': None,
        'batch_id': None
    }

    while offset < len(data):
        field, new_offset = parse_protobuf_field(data, offset)
        if field is None:
            break
        offset = new_offset

        wire_type, field_num, value = field

        if field_num == 1:  # otp_parameters (repeated)
            account = parse_otp_parameters(value)
            accounts.append(account)
        elif field_num == 2:  # version
            metadata['version'] = value
        elif field_num == 3:  # batch_size
            metadata['batch_size'] = value
        elif field_num == 4:  # batch_index
            metadata['batch_index'] = value
        elif field_num == 5:  # batch_id
            metadata['batch_id'] = value

    return accounts, metadata

def main():
    # 从文件读取二维码数据
    from PIL import Image
    from pyzbar.pyzbar import decode

    image_path = "D:/test/google_auth/微信图片_20260609234739_11972_1.jpg"

    print("=" * 80)
    print("Google Authenticator 多账号二维码详细解析")
    print("=" * 80)
    print()

    # 解码二维码
    img = Image.open(image_path)
    decoded = decode(img)

    if not decoded:
        print("错误：未找到二维码")
        return

    url = decoded[0].data.decode('utf-8')
    print(f"完整 URL:")
    print(url)
    print()

    # 提取 data 参数
    if "data=" not in url:
        print("错误：缺少 data 参数")
        return

    data_start = url.index("data=") + 5
    data_param = url[data_start:]

    # URL 解码
    data_param = unquote(data_param)
    print(f"Data 参数长度: {len(data_param)} 字符")
    print()

    # Base64 解码
    try:
        protobuf_data = base64.b64decode(data_param)
        print(f"Protobuf 数据长度: {len(protobuf_data)} 字节")
        print()
    except Exception as e:
        print(f"Base64 解码失败: {e}")
        return

    # 解析 Protobuf
    accounts, metadata = parse_migration_payload(protobuf_data)

    print("=" * 80)
    print(f"解析结果: 找到 {len(accounts)} 个账号")
    print("=" * 80)
    print()

    # 打印元数据
    print("批次信息:")
    print(f"  版本: {metadata['version']}")
    print(f"  批次大小: {metadata['batch_size']}")
    print(f"  批次索引: {metadata['batch_index']}")
    print(f"  批次 ID: {metadata['batch_id']}")
    print()

    # 打印每个账号
    for i, account in enumerate(accounts, 1):
        print("-" * 80)
        print(f"账号 {i}:")
        print("-" * 80)
        print(f"  名称 (name):     {account['name']}")
        print(f"  发行者 (issuer): {account['issuer']}")
        print(f"  Secret (Base32): {account['secret_base32']}")
        print(f"  Secret (hex):    {account['secret'].hex()[:40]}...")
        print(f"  算法:            {account['algorithm']}")
        print(f"  位数:            {account['digits']}")
        print(f"  类型:            {account['type']}")
        if account['counter'] > 0:
            print(f"  计数器:          {account['counter']}")
        print()

        # 生成标准 otpauth URL
        otpauth = f"otpauth://totp/{account['name']}?"
        otpauth += f"secret={account['secret_base32']}"
        if account['issuer']:
            otpauth += f"&issuer={account['issuer']}"
        if account['algorithm'] != 'SHA1':
            otpauth += f"&algorithm={account['algorithm']}"
        if account['digits'] != 6:
            otpauth += f"&digits={account['digits']}"

        print(f"  标准 TOTP URL:")
        print(f"  {otpauth}")
        print()

    print("=" * 80)
    print("解析完成！")
    print("=" * 80)

if __name__ == "__main__":
    main()
