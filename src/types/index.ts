export interface PPTResource {
  id: string;
  title: string;
  url: string;
  type: 'ppt' | 'pptx';
  size?: number;
  chapterId?: string;
  courseId?: string;
  downloaded: boolean;
  /** 资料区额外参数（objectId, dataId, enc等） */
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

export interface DownloadTask {
  id: string;
  ppt: PPTResource;
  status: 'pending' | 'downloading' | 'converting' | 'completed' | 'error';
  progress: number;
  error?: string;
}

export interface MessageTypes {
  'GET_PPT_LIST': { courseId: string };
  'PPT_LIST_RESULT': { ppts: PPTResource[] };
  'DOWNLOAD_PPT': { ppt: PPTResource };
  'DOWNLOAD_PROGRESS': { taskId: string; progress: number; status: DownloadTask['status'] };
  'DOWNLOAD_COMPLETE': { taskId: string; blob: Blob };
  'BATCH_DOWNLOAD': { ppts: PPTResource[] };
  'SHOW_NOTIFICATION': { message: string; type: 'success' | 'error' | 'info' };
}
