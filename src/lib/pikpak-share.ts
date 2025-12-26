/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PikPak 分享链接解析客户端（免登录）
 * 参考 OpenList 的 pikpak_share 驱动实现
 */

interface CaptchaTokenResponse {
  captcha_token: string;
}

interface PassCodeTokenResponse {
  pass_code_token: string;
}

interface ShareInfoResponse {
  share_id: string;
  share_status: string;
  file_list: PikPakFile[];
}

interface PikPakFile {
  id: string;
  name: string;
  kind: 'drive#file' | 'drive#folder';
  size: string;
  mime_type: string;
}

interface FileUrlResponse {
  web_content_link: string;
  medias?: {
    media_id: string;
    media_name: string;
    video: {
      url: string;
    };
  }[];
}

export class PikPakShareClient {
  private deviceId: string;
  private captchaToken: string | null = null;
  private passCodeToken: string | null = null;
  private platform: 'android' | 'web' = 'android'; // 使用android平台更稳定

  constructor(shareId?: string, sharePwd?: string) {
    // 生成虚拟设备ID（使用随机字符串）
    const seed = (shareId || '') + (sharePwd || '') + Date.now().toString() + Math.random().toString();
    this.deviceId = this.simpleHash(seed);
  }

  /**
   * 简单哈希函数（替代 MD5）
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).padStart(32, '0');
  }

  /**
   * 获取验证码Token（类似设备签名）
   */
  private async getCaptchaToken(): Promise<string> {
    if (this.captchaToken) {
      return this.captchaToken;
    }

    const params = new URLSearchParams({
      client_id: this.platform === 'android' ? 'YNxT9w7GMdWvEOKa' : 'YUMx5nI8ZU8Ap8pm',
      action: 'get:share:info',
      device_id: this.deviceId,
      captcha_token: '',
      meta: JSON.stringify({
        email: '',
      }),
    });

    const response = await fetch(`https://user.mypikpak.com/v1/shield/captcha/init?${params}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': this.getUserAgent(),
        'X-Device-Id': this.deviceId,
        'X-Captcha-Token': '',
      },
    });

    if (!response.ok) {
      throw new Error('Failed to get captcha token');
    }

    const data: CaptchaTokenResponse = await response.json();
    this.captchaToken = data.captcha_token;

    return this.captchaToken;
  }

  /**
   * 获取密码Token（如果分享有密码）
   */
  private async getPassCodeToken(shareId: string, sharePwd: string): Promise<string> {
    if (this.passCodeToken) {
      return this.passCodeToken;
    }

    const captchaToken = await this.getCaptchaToken();

    const response = await fetch('https://api-drive.mypikpak.com/drive/v1/share/password/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': this.getUserAgent(),
        'X-Device-Id': this.deviceId,
        'X-Captcha-Token': captchaToken,
      },
      body: JSON.stringify({
        share_id: shareId,
        pass_code: sharePwd,
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to verify share password');
    }

    const data: PassCodeTokenResponse = await response.json();
    this.passCodeToken = data.pass_code_token;

    return this.passCodeToken;
  }

  /**
   * 获取分享信息
   */
  private async getShareInfo(shareId: string, sharePwd?: string): Promise<ShareInfoResponse> {
    const captchaToken = await this.getCaptchaToken();
    let passCodeToken = '';

    if (sharePwd) {
      passCodeToken = await this.getPassCodeToken(shareId, sharePwd);
    }

    const params = new URLSearchParams({
      share_id: shareId,
      pass_code_token: passCodeToken,
      thumbnail_size: 'SIZE_LARGE',
      limit: '100',
      with_audit: '1',
    });

    const response = await fetch(`https://api-drive.mypikpak.com/drive/v1/share?${params}`, {
      headers: {
        'User-Agent': this.getUserAgent(),
        'X-Device-Id': this.deviceId,
        'X-Captcha-Token': captchaToken,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to get share info');
    }

    return await response.json();
  }

  /**
   * 获取文件播放地址
   */
  private async getFileUrl(shareId: string, fileId: string, sharePwd?: string): Promise<string> {
    const captchaToken = await this.getCaptchaToken();
    let passCodeToken = '';

    if (sharePwd) {
      passCodeToken = await this.getPassCodeToken(shareId, sharePwd);
    }

    const params = new URLSearchParams({
      share_id: shareId,
      file_id: fileId,
      pass_code_token: passCodeToken,
      thumbnail_size: 'SIZE_LARGE',
    });

    const response = await fetch(`https://api-drive.mypikpak.com/drive/v1/share/file?${params}`, {
      headers: {
        'User-Agent': this.getUserAgent(),
        'X-Device-Id': this.deviceId,
        'X-Captcha-Token': captchaToken,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to get file url');
    }

    const data: FileUrlResponse = await response.json();

    // 优先返回转码后的视频地址（如果有）
    if (data.medias && data.medias.length > 0) {
      const media = data.medias.find(m => m.video && m.video.url);
      if (media) {
        return media.video.url;
      }
    }

    // 返回原始下载链接
    return data.web_content_link;
  }

  /**
   * 解析分享链接并获取播放地址
   * @param shareUrl 分享链接 (https://mypikpak.com/s/xxxxx)
   * @param sharePwd 提取码（可选）
   * @returns 第一个视频文件的播放地址
   */
  async parseShareLinkAndGetPlayUrl(shareUrl: string, sharePwd?: string): Promise<{
    playUrl: string;
    fileName: string;
    fileSize?: number;
  }> {
    // 从链接中提取 shareId
    const shareId = this.extractShareId(shareUrl);
    if (!shareId) {
      throw new Error('Invalid share URL');
    }

    // 获取分享信息
    const shareInfo = await this.getShareInfo(shareId, sharePwd);

    if (!shareInfo.file_list || shareInfo.file_list.length === 0) {
      throw new Error('No files found in share');
    }

    // 查找第一个视频文件
    const videoFile = this.findFirstVideoFile(shareInfo.file_list);
    if (!videoFile) {
      throw new Error('No video file found in share');
    }

    // 获取播放地址
    const playUrl = await this.getFileUrl(shareId, videoFile.id, sharePwd);

    return {
      playUrl,
      fileName: videoFile.name,
      fileSize: parseInt(videoFile.size),
    };
  }

  /**
   * 从分享链接中提取 shareId
   */
  private extractShareId(shareUrl: string): string | null {
    // 支持格式：
    // https://mypikpak.com/s/abc123
    // https://www.mypikpak.com/s/abc123
    const match = shareUrl.match(/\/s\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  /**
   * 查找第一个视频文件
   */
  private findFirstVideoFile(files: PikPakFile[]): PikPakFile | null {
    const videoMimeTypes = ['video/mp4', 'video/x-matroska', 'video/avi', 'video/quicktime'];
    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m3u8', '.ts'];

    for (const file of files) {
      if (file.kind === 'drive#file') {
        // 检查 MIME 类型
        if (file.mime_type && videoMimeTypes.includes(file.mime_type)) {
          return file;
        }

        // 检查文件扩展名
        const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
        if (videoExtensions.includes(ext)) {
          return file;
        }
      }
    }

    return null;
  }

  /**
   * 获取用户代理
   */
  private getUserAgent(): string {
    if (this.platform === 'android') {
      return 'protocolversion/200 clientid/YNxT9w7GMdWvEOKa action/ com.pikcloud.pikpak/1.43.1 libpassport/1.21.2 packageid/official sessionid/ deviceid/null providername/NONE devicesign/div101.073163eb9de8e1ded312c7c3be1e6e41f80684ed8eddc7ca47bb9e3bc52dd573 refresh_token/ sdkversion/8.4.2 datetime/1696991225246 usrno/null appname/android-com.pikcloud.pikpak session_origin/ grant_type/ devicename/Xiaomi_M2004j7ac creditkey/null devicemodel/M2004J7AC OSVersion/13 platformversion/10 accesstype/ clientver/1.43.1 networktype/WIFI sessionid/ deviceid/null providername/NONE devicesign/div101.073163eb9de8e1ded312c7c3be1e6e41f80684ed8eddc7ca47bb9e3bc52dd573';
    } else {
      return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36';
    }
  }
}
