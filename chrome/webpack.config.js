const path = require('path');

module.exports = {
  entry: './content/main.js',
  output: {
    filename: 'content.js',
    path: path.resolve(__dirname, 'dist'),
    environment: {
      arrowFunction: true, // Ensure modern JS features
      dynamicImport: false // Disable dynamic imports to avoid eval
    }
  },
  mode: 'production',
  resolve: {
    extensions: ['.js'],
  },
  devtool: false, // Disable source maps to avoid eval
};