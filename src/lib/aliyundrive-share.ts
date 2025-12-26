/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 阿里云盘分享链接解析客户端
 * 参考 OpenList 的 aliyundrive_share 驱动实现
 */

const CANARY_HEADER_VALUE = 'client=web,app=share,version=v2.3.1';

interface AliyundriveTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface ShareTokenResponse {
  share_token: string;
  expire_time: string;
}

interface FileItem {
  file_id: string;
  name: string;
  type: 'file' | 'folder';
  size?: number;
  category?: string;
}

interface FileListResponse {
  items: FileItem[];
  next_marker: string;
}

interface DownloadUrlResponse {
  url: string;
  download_url: string;
}

export class AliyundriveShareClient {
  private accessToken: string | null = null;
  private refreshToken: string;
  private shareToken: string | null = null;
  private tokenExpireTime: number = 0;

  constructor(refreshToken: string) {
    this.refreshToken = refreshToken;
  }

  /**
   * 刷新 AccessToken
   */
  private async refreshAccessToken(): Promise<string> {
    const now = Date.now();

    // 如果 token 还未过期，直接返回
    if (this.accessToken && this.tokenExpireTime > now) {
      return this.accessToken;
    }

    const response = await fetch('https://auth.alipan.com/v2/account/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to refresh access token');
    }

    const data: AliyundriveTokenResponse = await response.json();
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token; // 更新 refresh token
    this.tokenExpireTime = now + (data.expires_in - 60) * 1000; // 提前60秒过期

    return this.accessToken;
  }

  /**
   * 获取分享 Token
   */
  private async getShareToken(shareId: string, sharePwd?: string): Promise<string> {
    const body: any = {
      share_id: shareId,
    };

    if (sharePwd) {
      body.share_pwd = sharePwd;
    }

    const response = await fetch('https://api.alipan.com/v2/share_link/get_share_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error('Failed to get share token');
    }

    const data: ShareTokenResponse = await response.json();
    this.shareToken = data.share_token;

    return this.shareToken;
  }

  /**
   * 列出分享文件夹中的文件
   */
  async listShareFiles(shareId: string, parentFileId: string = 'root'): Promise<FileItem[]> {
    const accessToken = await this.refreshAccessToken();

    if (!this.shareToken) {
      throw new Error('Share token not initialized');
    }

    const response = await fetch('https://api.alipan.com/adrive/v3/file/list', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer\t${accessToken}`,
        'x-share-token': this.shareToken,
        'X-Canary': CANARY_HEADER_VALUE,
        'Referer': 'https://www.alipan.com/',
      },
      body: JSON.stringify({
        parent_file_id: parentFileId,
        share_id: shareId,
        limit: 200,
        order_by: 'name',
        order_direction: 'ASC',
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to list share files');
    }

    const data: FileListResponse = await response.json();
    return data.items || [];
  }

  /**
   * 获取文件下载/播放地址
   */
  async getDownloadUrl(shareId: string, fileId: string, driveId?: string): Promise<string> {
    const accessToken = await this.refreshAccessToken();

    if (!this.shareToken) {
      throw new Error('Share token not initialized');
    }

    const response = await fetch('https://api.alipan.com/v2/file/get_share_link_download_url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer\t${accessToken}`,
        'x-share-token': this.shareToken,
        'X-Canary': CANARY_HEADER_VALUE,
        'Referer': 'https://www.alipan.com/',
      },
      body: JSON.stringify({
        file_id: fileId,
        share_id: shareId,
        expire_sec: 600, // 10分钟有效期
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to get download url');
    }

    const data: DownloadUrlResponse = await response.json();
    return data.url || data.download_url;
  }

  /**
   * 解析分享链接并获取播放地址
   * @param shareUrl 分享链接 (https://www.alipan.com/s/xxxxx)
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

    // 获取 share token
    await this.getShareToken(shareId, sharePwd);

    // 列出文件
    const files = await this.listShareFiles(shareId);

    // 查找第一个视频文件
    const videoFile = this.findFirstVideoFile(files);
    if (!videoFile) {
      throw new Error('No video file found in share');
    }

    // 获取播放地址
    const playUrl = await this.getDownloadUrl(shareId, videoFile.file_id);

    return {
      playUrl,
      fileName: videoFile.name,
      fileSize: videoFile.size,
    };
  }

  /**
   * 从分享链接中提取 shareId
   */
  private extractShareId(shareUrl: string): string | null {
    // 支持格式：
    // https://www.alipan.com/s/abc123
    // https://www.aliyundrive.com/s/abc123
    const match = shareUrl.match(/\/s\/([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
  }

  /**
   * 查找第一个视频文件
   */
  private findFirstVideoFile(files: FileItem[]): FileItem | null {
    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m3u8', '.ts'];

    for (const file of files) {
      if (file.type === 'file') {
        const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
        if (videoExtensions.includes(ext) || file.category === 'video') {
          return file;
        }
      }
    }

    return null;
  }

  /**
   * 更新 RefreshToken
   */
  updateRefreshToken(newRefreshToken: string) {
    this.refreshToken = newRefreshToken;
    this.accessToken = null;
    this.tokenExpireTime = 0;
  }

  /**
   * 获取当前的 RefreshToken（用于保存更新后的token）
   */
  getCurrentRefreshToken(): string {
    return this.refreshToken;
  }
}
