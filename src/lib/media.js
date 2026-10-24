// Strips EXIF/metadata from images by re-rendering them through a Canvas.
// Audio metadata is harder without external libs, so we focus on images first.

export const stripImageMetadata = async (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        
        // Export as a new Blob (this drops all original EXIF data)
        canvas.toBlob((blob) => {
          if (!blob) return reject(new Error('Canvas toBlob failed'));
          const cleanFile = new File([blob], file.name.split('.')[0] + '_clean.jpg', {
            type: 'image/jpeg',
            lastModified: Date.now()
          });
          resolve(cleanFile);
        }, 'image/jpeg', 0.9); // 90% quality
      };
      img.onerror = () => reject(new Error('Failed to load image for stripping'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
};
