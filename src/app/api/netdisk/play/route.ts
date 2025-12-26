/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { AliyundriveShareClient } from '@/lib/aliyundrive-share';
import { PikPakShareClient } from '@/lib/pikpak-share';
import { Pan123ShareClient } from '@/lib/123pan-share';
import { db } from '@/lib/db';
import { Cloud115ShareClient } from '@/lib/115cloud-share';
import { getConfig, clearConfigCache } from '@/lib/config';

/**
 * 网盘分享链接播放 API
 * POST /api/netdisk/play
 * Body: { shareUrl: string, sharePwd?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { shareUrl, sharePwd } = body;

    if (!shareUrl) {
      return NextResponse.json(
        { error: 'Missing shareUrl parameter' },
        { status: 400 }
      );
    }

    // 判断网盘类型
    const platform = detectPlatform(shareUrl);

    if (!platform) {
      return NextResponse.json(
        { error: 'Unsupported share platform' },
        { status: 400 }
      );
    }

    let result;

    switch (platform) {
      case 'aliyundrive':
        result = await handleAliyundrive(shareUrl, sharePwd);
        break;
      case 'pikpak':
      case '123pan':
        result = await handle123Pan(shareUrl, sharePwd);
        break;
      case '115cloud':
        result = await handle115Cloud(shareUrl, sharePwd);
        break;
        result = await handlePikPak(shareUrl, sharePwd);
        break;
      default:
        return NextResponse.json(
          { error: `Platform ${platform} not yet implemented` },
          { status: 501 }
        );
    }

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Error parsing share link:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to parse share link' },
      { status: 500 }
    );
  }
}

/**
 * 检测网盘平台
 */
function detectPlatform(shareUrl: string): string | null {
  const url = shareUrl.toLowerCase();

  if (url.includes('alipan.com') || url.includes('aliyundrive.com')) {
    return 'aliyundrive';
  }

  if (url.includes('mypikpak.com')) {
    return 'pikpak';
  }

  if (url.includes('123pan.com') || url.includes('123yunpan.com')) {
    return '123pan';
  }
  
  if (url.includes('115.com')) {
    return '115cloud';
  }

  return null;
}

/**
 * 处理阿里云盘分享链接
 */
async function handleAliyundrive(shareUrl: string, sharePwd?: string) {
  // 从数据库获取配置
  const config = await getConfig();

  const aliyunConfig = config?.NetDiskShareConfig?.aliyundrive;

  if (!aliyunConfig || !aliyunConfig.enabled || !aliyunConfig.refreshToken) {
    throw new Error('阿里云盘未配置或未启用，请在管理后台配置 RefreshToken');
  }

  // 创建客户端
  const client = new AliyundriveShareClient(aliyunConfig.refreshToken);

  // 解析并获取播放地址
  const result = await client.parseShareLinkAndGetPlayUrl(shareUrl, sharePwd);

  // 保存更新后的 RefreshToken（如果有变化）
  const newRefreshToken = client.getCurrentRefreshToken();
  if (newRefreshToken !== aliyunConfig.refreshToken) {
    aliyunConfig.refreshToken = newRefreshToken;
    await db.saveAdminConfig(config);
    clearConfigCache();
  }

  return {
    success: true,
    platform: 'aliyundrive',
    ...result,
  };
}

/**
 * 处理 PikPak 分享链接
 */
async function handlePikPak(shareUrl: string, sharePwd?: string) {
  // PikPak 免登录，直接创建客户端
  const client = new PikPakShareClient(shareUrl, sharePwd);

  // 解析并获取播放地址
  const result = await client.parseShareLinkAndGetPlayUrl(shareUrl, sharePwd);

  return {
    success: true,
    platform: 'pikpak',
    ...result,
  };
}
