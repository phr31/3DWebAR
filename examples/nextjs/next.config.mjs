/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next 15+ rejeita requisições de dev vindas de outra origem. Sem isto o
  // túnel HTTPS (obrigatório para testar câmera no celular) não funciona.
  allowedDevOrigins: ['*.trycloudflare.com', '*.ngrok-free.app', '*.ngrok.io'],
};

export default nextConfig;
