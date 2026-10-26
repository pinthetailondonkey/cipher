import React from 'react';

export default function Logo({ size = 32, className = '' }) {
  return (
    <img 
      src="/logo_raw.png?v=3"
      alt="Cipher Logo" 
      width={size} 
      height={size} 
      className={`object-contain ${className}`} 
      draggable={false}
    />
  );
}
