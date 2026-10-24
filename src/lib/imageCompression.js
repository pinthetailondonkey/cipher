export const compressImage = async (file, maxWidth = 1280, quality = 0.78) => {
  if (!(file instanceof Blob) || !file.type.startsWith('image/')) {
    throw new Error('Please choose a valid image file.');
  }

  let bitmap;
  let imageUrl;
  try {
    if ('createImageBitmap' in globalThis) {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } else {
      bitmap = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Could not read the selected image.'));
        imageUrl = URL.createObjectURL(file);
        image.src = imageUrl;
      });
    }

    const scale = Math.min(1, maxWidth / bitmap.width, maxWidth / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Image compression is unavailable in this browser.');
    context.drawImage(bitmap, 0, 0, width, height);

    const compressed = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('Could not compress the selected image.')),
        'image/jpeg',
        quality,
      );
    });
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
    return new File([compressed], `${baseName}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    });
  } finally {
    bitmap?.close?.();
    if (imageUrl) URL.revokeObjectURL(imageUrl);
  }
};

export const formatFileSize = (bytes) => {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
};
