/**
 * Pollinations.ai API Client
 * 
 * FREE image generation - no API key required!
 * https://pollinations.ai
 * 
 * This replaces the Replicate client with Pollinations.ai which is:
 * - Completely free
 * - No API key needed
 * - No signup required
 * - Supports multiple models (Flux, Turbo, etc.)
 * 
 * KEY CONCEPTS:
 * - Simple GET request returns image directly
 * - URL-based API (prompt goes in URL)
 * - Error classification (retryable vs permanent)
 */

// Pollinations image endpoint - just encode prompt in URL
const POLLINATIONS_BASE_URL = 'https://image.pollinations.ai/prompt';

class PollinationsClient {
  constructor() {
    // No API key needed!
    this.timeout = 120000; // 2 minute timeout per task
    this.model = 'flux'; // Default model - fast and good quality
    this.width = 1024;
    this.height = 1024;
  }

  /**
   * Generate an image from a prompt
   * 
   * Pollinations is simpler than Replicate:
   * - No "create prediction then poll" dance
   * - Just make a GET request with the prompt in the URL
   * - The response IS the image (or redirects to CDN URL)
   * 
   * We still simulate progress for the UI since we don't get
   * real progress updates from Pollinations.
   */
  async generateImage(prompt, onProgress) {
    const startTime = Date.now();

    // Build the URL with parameters
    const encodedPrompt = encodeURIComponent(prompt);
    const seed = Math.floor(Math.random() * 1000000);
    const imageUrl = `${POLLINATIONS_BASE_URL}/${encodedPrompt}?width=${this.width}&height=${this.height}&model=${this.model}&nologo=true&seed=${seed}`;

    // Simulate initial progress
    if (onProgress) onProgress(10);

    try {
      // Create an AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      // Simulate progress while waiting
      const progressInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        // Estimate ~20 seconds for generation, cap at 90%
        const estimatedProgress = Math.min(90, 10 + Math.floor((elapsed / 20000) * 80));
        if (onProgress) onProgress(estimatedProgress);
      }, 1000);

      // Make the actual request - Pollinations generates and returns the image
      // We fetch it to ensure it's generated successfully before returning the URL
      const response = await fetch(imageUrl, {
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      clearInterval(progressInterval);

      if (!response.ok) {
        const error = await this.parseError(response);
        throw error;
      }

      // Verify we got an image back
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('image')) {
        const error = new Error('API did not return an image');
        error.code = 'INVALID_RESPONSE';
        error.isRetryable = true;
        throw error;
      }

      // Success! The imageUrl is now cached and ready to serve
      if (onProgress) onProgress(100);

      return {
        imageUrl: imageUrl,
        generatedAt: Date.now(),
        processingTime: Date.now() - startTime,
        model: this.model
      };

    } catch (error) {
      if (error.name === 'AbortError') {
        const timeoutError = new Error('Image generation timed out');
        timeoutError.code = 'TIMEOUT';
        timeoutError.isRetryable = true;
        throw timeoutError;
      }

      // Network errors are retryable
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'UND_ERR_CONNECT_TIMEOUT') {
        error.isRetryable = true;
      }

      throw error;
    }
  }

  /**
   * Parse error response
   */
  async parseError(response) {
    let message = `HTTP ${response.status}`;

    try {
      const text = await response.text();
      if (text) {
        message = `${message}: ${text.substring(0, 200)}`;
      }
    } catch {
      message = `${message}: ${response.statusText}`;
    }

    const error = new Error(message);
    error.code = `HTTP_${response.status}`;
    error.statusCode = response.status;
    error.isRetryable = this.isRetryableStatusCode(response.status);

    return error;
  }

  /**
   * Determine if an HTTP status code indicates a retryable error
   * 
   * KEY INSIGHT: Error classification is crucial for retry logic.
   * 
   * RETRYABLE (might work next time):
   * - 429: Rate limited (back off and try later)
   * - 500: Server error (might be temporary)
   * - 502: Bad gateway (often temporary)
   * - 503: Service unavailable (server overloaded)
   * - 504: Gateway timeout (might work with more time)
   * 
   * NON-RETRYABLE (won't ever work):
   * - 400: Bad request (our input is wrong)
   * - 401: Unauthorized (shouldn't happen - no auth needed!)
   * - 403: Forbidden (content policy violation)
   * - 404: Not found (endpoint doesn't exist)
   */
  isRetryableStatusCode(statusCode) {
    const retryableCodes = [429, 500, 502, 503, 504];
    return retryableCodes.includes(statusCode);
  }
}

module.exports = PollinationsClient;