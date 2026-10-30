// Test fixtures for seeding vault to bypass lock screen
export function seedVault() {
  // Create a minimal account so the app loads past lock screen
  const mockSk = [170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170, 170];

  // Set session storage - the app checks cipher_session_sk first
  sessionStorage.setItem('cipher_session_sk', JSON.stringify(mockSk));
}
