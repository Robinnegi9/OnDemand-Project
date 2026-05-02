# Household Service Provider Application

This is a full-stack on-demand household services application where:

- Customers can register/login and book services.
- Service providers can register/login and manage profile settings.
- Supported services include Electrician, Plumber, Cook, Gardener, and more.
- Providers can configure working hours, payment modes, and availability.
- Customers can create bookings and track status (Pending, Accepted, Rejected, Completed).
- Customers can cancel bookings while they are Pending or Accepted.
- Customers can submit ratings and reviews for completed services.
- Admin can monitor analytics and manage providers/bookings.

## Features

- Role-based registration: `customer` or `service provider`
- Login/logout authentication with session handling
- Provider profile management:
  - Service category
  - Experience
  - Hourly rate
  - Working hours
  - Payment modes
  - Availability toggle
- Customer dashboard:
  - Browse/filter providers
  - Book service with date/time/address/payment mode
  - Track booking status and cancel active bookings
- Provider dashboard:
  - View incoming bookings
  - Update booking status
- Review and rating module:
  - Customers can rate completed bookings (1-5 stars)
  - Providers can view recent reviews and average rating
- Admin dashboard:
  - Platform analytics (customers/providers/bookings/completion rate)
  - Toggle provider availability
  - Moderate booking statuses
- JSON file-based persistent storage (`data.json`)
- Booking validation improvements:
  - Service date cannot be in the past
  - Booking time must be within provider working hours
  - Payment mode must match provider supported modes

## Tech Stack

- Node.js
- Express.js
- express-session
- bcryptjs

## Run Locally

1. Open terminal in project folder:

   ```bash
   cd household-service-app
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the application:

   ```bash
   npm start
   ```

4. Open:

   [http://localhost:3000](http://localhost:3000)

## Admin Login

- Email: `admin@household.local`
- Password: `admin123`

## Demo Data

The app seeds demo providers on first run.

- Sample provider password: `password123`
- Emails include:
  - `ravi.electrician@example.com`
  - `mohan.plumber@example.com`
  - `greenleaf.gardener@example.com`

You can also create your own customer and provider accounts from the homepage.
