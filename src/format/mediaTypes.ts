// File types BananaVinci imports. Shared by the server (import + conversion) and the UI (file pickers).

/** Formats the browser decodes itself (the preview and the export both draw through the browser). */
export const NATIVE = {
  image: ['.png', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.bmp', '.svg', '.avif', '.apng', '.ico'],
  audio: ['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.weba'],
  video: ['.mp4', '.mov', '.webm', '.mkv', '.m4v'],
};

/** Formats accepted on import but converted with ffmpeg first (to PNG, M4A or MP4). */
export const CONVERTED = {
  image: ['.tif', '.tiff', '.heic', '.heif', '.tga', '.psd'],
  audio: ['.aif', '.aiff', '.wma', '.amr', '.ac3', '.mka', '.caf'],
  video: ['.avi', '.wmv', '.flv', '.mpg', '.mpeg', '.3gp', '.ts', '.mts', '.m2ts', '.ogv', '.mxf', '.vob', '.dv'],
};

export const SUPPORTED = [...Object.values(NATIVE), ...Object.values(CONVERTED)].flat();

/** `accept` attribute for media file inputs. Extensions are listed too, since many (.mkv, .heic, .mts) have no MIME type on Windows. */
export const MEDIA_ACCEPT = ['image/*', 'video/*', 'audio/*', ...SUPPORTED].join(',');
