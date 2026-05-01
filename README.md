# Elysia Perpus

<img src="https://elysiajs.com/assets/elysia_v.webp" width="120" alt="Elysia Logo" />

A modern library management system built with the Elysia.js framework and Bun runtime. This project utilizes Material Design 3 standards for the user interface.

## Installation

To install dependencies:
```bash
bun install
```

## Execution

To run the server:

```bash
bun run index.ts
```

## Features

*   **Material You Interface**: Implements responsive Google Material 3 design standards.
*   **Profile Management**: Users can upload and crop profile pictures directly within the application.
*   **Admin Dashboard**: Tools for monitoring system statistics, managing user lists, and adding book collections.
*   **Book Tracking**: Every book added is automatically assigned a structured unique identifier (e.g., EP-10001).
*   **Core Security**: Equipped with Security Headers (HSTS, CSP) and JWT-based authentication.
*   **Synchronization**: Utilizes SQLite with WAL (Write-Ahead Logging) mode for real-time data consistency.

## Tech Stack

*   **Runtime**: Bun v1.3.13
*   **Framework**: Elysia.js
*   **Database**: SQLite (via bun:sqlite)
*   **UI Library**: Material Web Components and Material Symbols
*   **Imaging**: Cropper.js

## Directory Structure

*   `index.ts`: Main backend logic and database configuration.
*   `public/`: Frontend assets including index.html, login.html, and register.html.
*   `database/`: Directory for SQLite database files.
*   `public/uploads/`: Storage for user profile pictures.
*   `public/covers/`: Storage for book cover images.

---
This project was created using `bun init` in Bun v1.3.13. Bun is a fast all-in-one JavaScript runtime.