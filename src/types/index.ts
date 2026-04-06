export interface PPTResource {
  id: string;
  title: string;
  url: string;
  type: 'ppt' | 'pptx' | 'pdf' | 'mp4' | 'doc' | 'xls' | 'zip' | 'other';
  size?: number;
  chapterId?: string;
  courseId?: string;
  downloaded: boolean;
  meta?: Record<string, string>;
}

export interface ChapterInfo {
  id: string;
  title: string;
  ppts: PPTResource[];
}

export interface CourseInfo {
  id: string;
  name: string;
  chapters: ChapterInfo[];
}

export interface DownloadResult {
  success: boolean;
  error?: string;
  downloadId?: number;
  blobSize?: number;
  httpStatus?: number;
}

export interface BatchDownloadResult {
  success: boolean;
  totalFiles?: number;
  successCount?: number;
  failCount?: number;
  results?: Array<{ filename: string; success: boolean; error?: string }>;
}

export type ResourceType = PPTResource['type'];

/** 支持的文件类型扩展名映射 */
export const FILE_TYPE_MAP: Record<string, ResourceType> = {
  ppt: 'ppt',
  pptx: 'pptx',
  pdf: 'pdf',
  mp4: 'mp4',
  doc: 'doc',
  docx: 'doc',
  xls: 'xls',
  xlsx: 'xls',
  zip: 'zip',
  rar: 'zip',
};

/** 从文件扩展名推断资源类型 */
export function inferFileType(filename: string): ResourceType {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return FILE_TYPE_MAP[ext] || 'other';
}
