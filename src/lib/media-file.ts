type FileInfo = Pick<File, 'name' | 'type'>;

export function isMidiFile(file: FileInfo): boolean {
  return /\.(mid|midi)$/i.test(file.name) || /^(audio\/(x-)?midi|audio\/mid|audio\/sp-midi|application\/(x-)?midi)$/i.test(file.type);
}

export function isPlaybackFile(file: FileInfo): boolean {
  return isMidiFile(file) || file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac|opus|webm)$/i.test(file.name);
}
