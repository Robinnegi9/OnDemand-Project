const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DATA_PATH = path.join(__dirname, "data.json");

const SERVICES = [
  "Electrician",
  "Plumber",
  "Cook",
  "Gardener",
  "Carpenter",
  "Cleaner",
  "Painter",
  "AC Technician"
];
const PAYMENT_MODES = ["Cash", "UPI", "Card", "Bank Transfer"];
const COMPLETION_SLA_MS = 48 * 60 * 60 * 1000;
const COMPLETION_OTP_TTL_MS = 15 * 60 * 1000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: "replace-with-secure-secret",
    resave: false,
    saveUninitialized: false
  })
);

initializeDataFile();

app.get("/", (req, res) => {
  if (!req.session.user) return res.send(renderHomePage());
  if (req.session.user.role === "provider") return res.redirect("/provider/dashboard");
  if (req.session.user.role === "admin") return res.redirect("/admin/dashboard");
  return res.redirect("/customer/dashboard");
});

app.post("/register", (req, res) => {
  const { name, email, phone, password, role } = req.body;
  if (!name || !email || !phone || !password || !role) {
    return res.send(renderHomePage("All registration fields are required."));
  }
  if (!["customer", "provider"].includes(role)) {
    return res.send(renderHomePage("Invalid registration role selected."));
  }

  const data = loadData();
  const normalizedEmail = email.trim().toLowerCase();
  if (data.users.some((u) => u.email === normalizedEmail)) {
    return res.send(renderHomePage("Email already exists. Please login."));
  }

  const userId = data.meta.nextUserId++;
  const user = {
    id: userId,
    name: name.trim(),
    email: normalizedEmail,
    phone: phone.trim(),
    passwordHash: bcrypt.hashSync(password, 10),
    role,
    createdAt: new Date().toISOString()
  };
  data.users.push(user);

  if (role === "provider") {
    const {
      serviceCategory,
      experienceYears,
      hourlyRate,
      workStart,
      workEnd,
      paymentModes,
      availableNow
    } = req.body;

    data.providerProfiles.push({
      id: data.meta.nextProviderProfileId++,
      userId,
      serviceCategory: serviceCategory || "Electrician",
      experienceYears: Number(experienceYears || 1),
      hourlyRate: Number(hourlyRate || 300),
      workStart: workStart || "09:00",
      workEnd: workEnd || "18:00",
      paymentModes: normalizeToArray(paymentModes),
      availableNow: availableNow === "on"
    });
  }

  saveData(data);
  req.session.user = { id: user.id, name: user.name, role: user.role };
  return res.redirect(role === "provider" ? "/provider/dashboard" : "/customer/dashboard");
});

app.post("/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.send(renderHomePage("Please enter email and password."));

  const data = loadData();
  const user = data.users.find((u) => u.email === email.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.send(renderHomePage("Invalid email or password."));
  }

  req.session.user = { id: user.id, name: user.name, role: user.role };
  if (user.role === "provider") return res.redirect("/provider/dashboard");
  if (user.role === "admin") return res.redirect("/admin/dashboard");
  return res.redirect("/customer/dashboard");
});

app.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

app.get("/customer/dashboard", auth("customer"), (req, res) => {
  const data = loadData();
  const selectedService = (req.query.service || "").trim();
  const search = (req.query.search || "").trim().toLowerCase();

  const providers = data.providerProfiles
    .map((profile) => {
      const user = data.users.find((u) => u.id === profile.userId);
      if (!user) return null;
      return {
        providerId: user.id,
        name: user.name,
        phone: user.phone,
        rating: calculateProviderRating(data.reviews, user.id),
        ...profile
      };
    })
    .filter(Boolean)
    .filter((p) => (selectedService ? p.serviceCategory === selectedService : true))
    .filter((p) =>
      search ? p.name.toLowerCase().includes(search) || p.serviceCategory.toLowerCase().includes(search) : true
    )
    .sort((a, b) => Number(b.availableNow) - Number(a.availableNow) || a.name.localeCompare(b.name));

  const bookings = data.bookings
    .filter((b) => b.customerId === req.session.user.id)
    .map((b) => {
      const providerUser = data.users.find((u) => u.id === b.providerId);
      const profile = data.providerProfiles.find((p) => p.userId === b.providerId);
      const otpExpiresMs = b.completionOtpExpiresAt ? new Date(b.completionOtpExpiresAt).getTime() : 0;
      const showOtpToCustomer =
        b.status === "Accepted" && b.completionOtp && otpExpiresMs > Date.now();
      return {
        ...b,
        providerName: providerUser ? providerUser.name : "Unknown",
        serviceCategory: profile ? profile.serviceCategory : "Unknown",
        hasReview: data.reviews.some((r) => r.bookingId === b.id),
        showOtpToCustomer
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const notifications = (data.notifications || [])
    .filter((n) => n.userId === req.session.user.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 30);

  res.send(
    renderCustomerDashboard({
      user: req.session.user,
      providers,
      services: SERVICES,
      paymentModes: PAYMENT_MODES,
      bookings,
      filters: { selectedService, search },
      message: req.query.msg || "",
      notifications
    })
  );
});

app.post("/customer/notifications/read", auth("customer"), (req, res) => {
  const data = loadData();
  data.notifications = data.notifications || [];
  const uid = req.session.user.id;
  for (const n of data.notifications) {
    if (n.userId === uid) n.read = true;
  }
  saveData(data);
  return res.redirect("/customer/dashboard");
});

app.post("/bookings/create", auth("customer"), (req, res) => {
  const { providerId, serviceDate, serviceTime, address, paymentMode, notes } = req.body;
  if (!providerId || !serviceDate || !serviceTime || !address || !paymentMode) {
    return res.redirect("/customer/dashboard?msg=Please+fill+all+booking+fields");
  }

  const data = loadData();
  const providerUser = data.users.find((u) => u.id === Number(providerId) && u.role === "provider");
  if (!providerUser) return res.redirect("/customer/dashboard?msg=Selected+provider+not+found");
  const providerProfile = data.providerProfiles.find((p) => p.userId === Number(providerId));
  if (!providerProfile) return res.redirect("/customer/dashboard?msg=Provider+profile+not+found");

  const today = todayDateString();
  if (serviceDate < today) {
    return res.redirect("/customer/dashboard?msg=Service+date+cannot+be+in+the+past");
  }

  if (providerProfile.paymentModes.length > 0 && !providerProfile.paymentModes.includes(paymentMode)) {
    return res.redirect("/customer/dashboard?msg=Selected+payment+mode+not+supported+by+provider");
  }

  if (serviceTime < providerProfile.workStart || serviceTime > providerProfile.workEnd) {
    return res.redirect("/customer/dashboard?msg=Service+time+must+be+within+provider+working+hours");
  }

  data.bookings.push({
    id: data.meta.nextBookingId++,
    customerId: req.session.user.id,
    providerId: Number(providerId),
    serviceDate,
    serviceTime,
    address: address.trim(),
    paymentMode,
    notes: (notes || "").trim(),
    status: "Pending",
    createdAt: new Date().toISOString()
  });
  saveData(data);

  return res.redirect("/customer/dashboard?msg=Booking+created+successfully");
});

app.post("/bookings/cancel", auth("customer"), (req, res) => {
  const { bookingId } = req.body;
  if (!bookingId) return res.redirect("/customer/dashboard?msg=Invalid+booking+request");

  const data = loadData();
  const booking = data.bookings.find((b) => b.id === Number(bookingId) && b.customerId === req.session.user.id);
  if (!booking) return res.redirect("/customer/dashboard?msg=Booking+not+found");
  if (!["Pending", "Accepted"].includes(booking.status)) {
    return res.redirect("/customer/dashboard?msg=This+booking+cannot+be+cancelled");
  }

  booking.status = "Cancelled";
  saveData(data);
  return res.redirect("/customer/dashboard?msg=Booking+cancelled+successfully");
});

app.post("/reviews/create", auth("customer"), (req, res) => {
  const { bookingId, rating, comment } = req.body;
  const normalizedRating = Number(rating);

  if (!bookingId || Number.isNaN(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
    return res.redirect("/customer/dashboard?msg=Please+add+a+valid+rating+between+1+and+5");
  }

  const data = loadData();
  const booking = data.bookings.find((b) => b.id === Number(bookingId) && b.customerId === req.session.user.id);
  if (!booking) return res.redirect("/customer/dashboard?msg=Booking+not+found");
  if (booking.status !== "Completed") {
    return res.redirect("/customer/dashboard?msg=Only+completed+bookings+can+be+rated");
  }
  if (data.reviews.some((r) => r.bookingId === Number(bookingId))) {
    return res.redirect("/customer/dashboard?msg=Review+already+submitted+for+this+booking");
  }

  data.reviews.push({
    id: data.meta.nextReviewId++,
    bookingId: booking.id,
    customerId: booking.customerId,
    providerId: booking.providerId,
    rating: normalizedRating,
    comment: (comment || "").trim(),
    createdAt: new Date().toISOString()
  });
  saveData(data);
  return res.redirect("/customer/dashboard?msg=Thanks+for+your+feedback");
});

app.get("/admin/dashboard", auth("admin"), (req, res) => {
  const data = loadData();
  const stats = {
    customers: data.users.filter((u) => u.role === "customer").length,
    providers: data.users.filter((u) => u.role === "provider").length,
    bookings: data.bookings.length,
    completedBookings: data.bookings.filter((b) => b.status === "Completed").length,
    avgRating: averageRating(data.reviews)
  };
  const providers = data.users
    .filter((u) => u.role === "provider")
    .map((u) => {
      const profile = data.providerProfiles.find((p) => p.userId === u.id);
      return {
        ...u,
        availableNow: profile ? profile.availableNow : false,
        category: profile ? profile.serviceCategory : "N/A",
        rating: calculateProviderRating(data.reviews, u.id)
      };
    });
  const recentBookings = data.bookings
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 20)
    .map((b) => {
      const customer = data.users.find((u) => u.id === b.customerId);
      const provider = data.users.find((u) => u.id === b.providerId);
      return {
        ...b,
        customerName: customer ? customer.name : "Unknown",
        providerName: provider ? provider.name : "Unknown"
      };
    });

  return res.send(
    renderAdminDashboard({
      user: req.session.user,
      stats,
      providers,
      bookings: recentBookings,
      message: req.query.msg || ""
    })
  );
});

app.post("/admin/providers/toggle", auth("admin"), (req, res) => {
  const { providerId } = req.body;
  const data = loadData();
  const profile = data.providerProfiles.find((p) => p.userId === Number(providerId));
  if (!profile) return res.redirect("/admin/dashboard?msg=Provider+profile+not+found");
  profile.availableNow = !profile.availableNow;
  saveData(data);
  return res.redirect("/admin/dashboard?msg=Provider+availability+updated");
});

app.post("/admin/bookings/status", auth("admin"), (req, res) => {
  const { bookingId, status } = req.body;
  const allowed = ["Pending", "Accepted", "Rejected", "Completed", "Cancelled"];
  if (!bookingId || !allowed.includes(status)) {
    return res.redirect("/admin/dashboard?msg=Invalid+status+update");
  }
  const data = loadData();
  const booking = data.bookings.find((b) => b.id === Number(bookingId));
  if (!booking) return res.redirect("/admin/dashboard?msg=Booking+not+found");
  booking.status = status;
  booking.completionOtp = null;
  booking.completionOtpExpiresAt = null;
  if (status === "Accepted" && !booking.acceptedAt) {
    booking.acceptedAt = new Date().toISOString();
    booking.completionDueAt = new Date(Date.now() + COMPLETION_SLA_MS).toISOString();
  }
  if (!["Accepted", "Completed"].includes(status)) {
    booking.acceptedAt = null;
    booking.completionDueAt = null;
  }
  saveData(data);
  return res.redirect("/admin/dashboard?msg=Booking+status+updated");
});

app.get("/provider/dashboard", auth("provider"), (req, res) => {
  const data = loadData();
  const profile = data.providerProfiles.find((p) => p.userId === req.session.user.id);
  const providerReviews = data.reviews
    .filter((r) => r.providerId === req.session.user.id)
    .map((r) => {
      const customer = data.users.find((u) => u.id === r.customerId);
      return { ...r, customerName: customer ? customer.name : "Unknown" };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const now = Date.now();
  const bookings = data.bookings
    .filter((b) => b.providerId === req.session.user.id)
    .map((b) => {
      const customer = data.users.find((u) => u.id === b.customerId);
      const otpExpiresMs = b.completionOtpExpiresAt ? new Date(b.completionOtpExpiresAt).getTime() : 0;
      const otpAwaitingCustomer =
        b.status === "Accepted" && b.completionOtp && otpExpiresMs > now;
      return {
        ...b,
        customerName: customer ? customer.name : "Unknown",
        customerPhone: customer ? customer.phone : "N/A",
        otpAwaitingCustomer
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  res.send(
    renderProviderDashboard({
      user: req.session.user,
      profile,
      services: SERVICES,
      paymentModes: PAYMENT_MODES,
      bookings,
      reviews: providerReviews,
      averageRating: calculateProviderRating(data.reviews, req.session.user.id),
      message: req.query.msg || ""
    })
  );
});

app.post("/provider/profile/update", auth("provider"), (req, res) => {
  const { serviceCategory, experienceYears, hourlyRate, workStart, workEnd, paymentModes, availableNow } =
    req.body;
  const data = loadData();
  const profile = data.providerProfiles.find((p) => p.userId === req.session.user.id);
  if (!profile) return res.redirect("/provider/dashboard?msg=Provider+profile+missing");
  if (!serviceCategory || Number(hourlyRate) < 100 || Number(experienceYears) < 1) {
    return res.redirect("/provider/dashboard?msg=Please+enter+valid+profile+details");
  }
  if (!isValidTimeRange(workStart, workEnd)) {
    return res.redirect("/provider/dashboard?msg=Working+hours+must+have+end+time+after+start+time");
  }

  profile.serviceCategory = serviceCategory;
  profile.experienceYears = Number(experienceYears || 1);
  profile.hourlyRate = Number(hourlyRate || 300);
  profile.workStart = workStart || "09:00";
  profile.workEnd = workEnd || "18:00";
  profile.paymentModes = normalizeToArray(paymentModes);
  profile.availableNow = availableNow === "on";
  saveData(data);

  return res.redirect("/provider/dashboard?msg=Profile+updated");
});

app.post("/provider/bookings/status", auth("provider"), (req, res) => {
  const { bookingId, status, completionOtp } = req.body;
  const allowed = ["Pending", "Accepted", "Rejected", "Completed", "Cancelled"];
  if (!bookingId || !allowed.includes(status)) {
    return res.redirect("/provider/dashboard?msg=Invalid+booking+status+request");
  }

  const data = loadData();
  data.notifications = data.notifications || [];
  const booking = data.bookings.find((b) => b.id === Number(bookingId) && b.providerId === req.session.user.id);
  if (!booking) return res.redirect("/provider/dashboard?msg=Booking+not+found");

  const otpInput = String(completionOtp || "").trim();
  const nowMs = Date.now();

  if (status === "Completed") {
    if (booking.status !== "Accepted") {
      return res.redirect(
        "/provider/dashboard?msg=" + encodeURIComponent("Mark the booking as Accepted before completing it.")
      );
    }

    const otpExpiresMs = booking.completionOtpExpiresAt ? new Date(booking.completionOtpExpiresAt).getTime() : 0;
    const otpStillValid = booking.completionOtp && otpExpiresMs > nowMs;

    if (otpStillValid) {
      if (!otpInput) {
        return res.redirect(
          "/provider/dashboard?msg=" + encodeURIComponent("Enter the OTP the customer received to confirm completion.")
        );
      }
      if (otpInput !== String(booking.completionOtp)) {
        return res.redirect("/provider/dashboard?msg=" + encodeURIComponent("Invalid OTP. Try again."));
      }
      booking.status = "Completed";
      booking.completionOtp = null;
      booking.completionOtpExpiresAt = null;
      addCustomerNotification(data, {
        userId: booking.customerId,
        bookingId: booking.id,
        message: `Your booking #${booking.id} has been marked completed.`
      });
      saveData(data);
      return res.redirect("/provider/dashboard?msg=" + encodeURIComponent("Booking marked completed."));
    }

    if (otpInput) {
      return res.redirect(
        "/provider/dashboard?msg=" +
          encodeURIComponent("OTP expired or not yet sent. Clear the OTP field and submit again to request a new code.")
      );
    }

    booking.completionOtp = String(Math.floor(100000 + Math.random() * 900000));
    booking.completionOtpExpiresAt = new Date(nowMs + COMPLETION_OTP_TTL_MS).toISOString();
    const providerUser = data.users.find((u) => u.id === req.session.user.id);
    const pname = providerUser ? providerUser.name : "Provider";
    addCustomerNotification(data, {
      userId: booking.customerId,
      bookingId: booking.id,
      message: `${pname} requested completion for booking #${booking.id}. OTP: ${booking.completionOtp} (valid 15 min). Share this code with the provider only after the work is done.`
    });
    saveData(data);
    return res.redirect(
      "/provider/dashboard?msg=" +
        encodeURIComponent(
          "An OTP has been sent to the customer (and appears on their dashboard). After work is done, enter the OTP they give you and submit Completed again."
        )
    );
  }

  if (status === "Accepted" && booking.status !== "Accepted") {
    booking.acceptedAt = new Date().toISOString();
    booking.completionDueAt = new Date(nowMs + COMPLETION_SLA_MS).toISOString();
    booking.completionOtp = null;
    booking.completionOtpExpiresAt = null;
    const providerUser = data.users.find((u) => u.id === req.session.user.id);
    const pname = providerUser ? providerUser.name : "Your provider";
    addCustomerNotification(data, {
      userId: booking.customerId,
      bookingId: booking.id,
      message: `${pname} accepted your booking #${booking.id} (${booking.serviceDate} ${booking.serviceTime}).`
    });
  }

  if (status === "Rejected") {
    booking.acceptedAt = null;
    booking.completionDueAt = null;
    booking.completionOtp = null;
    booking.completionOtpExpiresAt = null;
    const providerUser = data.users.find((u) => u.id === req.session.user.id);
    const pname = providerUser ? providerUser.name : "A provider";
    addCustomerNotification(data, {
      userId: booking.customerId,
      bookingId: booking.id,
      message: `${pname} declined booking #${booking.id}.`
    });
  }

  if (!["Accepted", "Completed"].includes(status)) {
    booking.acceptedAt = null;
    booking.completionDueAt = null;
    booking.completionOtp = null;
    booking.completionOtpExpiresAt = null;
  }

  booking.status = status;
  saveData(data);
  return res.redirect("/provider/dashboard?msg=Booking+status+updated");
});

app.listen(PORT, () => {
  console.log(`Household service app running at http://localhost:${PORT}`);
});

function addCustomerNotification(data, { userId, bookingId, message }) {
  data.notifications = data.notifications || [];
  data.meta.nextNotificationId = Number(data.meta.nextNotificationId || 1);
  const id = data.meta.nextNotificationId++;
  data.notifications.push({
    id,
    userId: Number(userId),
    bookingId: bookingId != null ? Number(bookingId) : null,
    message: String(message || ""),
    read: false,
    createdAt: new Date().toISOString()
  });
}

function auth(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect("/");
    if (role && req.session.user.role !== role) return res.redirect("/");
    next();
  };
}

function normalizeToArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function initializeDataFile() {
  if (!fs.existsSync(DATA_PATH)) {
    const initial = {
      meta: { nextUserId: 1, nextProviderProfileId: 1, nextBookingId: 1, nextReviewId: 1, nextNotificationId: 1 },
      users: [],
      providerProfiles: [],
      bookings: [],
      reviews: [],
      notifications: []
    };
    seedDemoData(initial);
    fs.writeFileSync(DATA_PATH, JSON.stringify(initial, null, 2), "utf8");
    return;
  }
  const data = loadData();
  ensureDataShape(data);
  saveData(data);
}

function loadData() {
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
}

function saveData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");
}

function seedDemoData(data) {
  const adminId = data.meta.nextUserId++;
  data.users.push({
    id: adminId,
    name: "System Admin",
    email: "admin@household.local",
    phone: "9000000000",
    passwordHash: bcrypt.hashSync("admin123", 10),
    role: "admin",
    createdAt: new Date().toISOString()
  });

  const samples = [
    {
      name: "Ravi Electric Works",
      email: "ravi.electrician@example.com",
      phone: "9876543210",
      category: "Electrician",
      experience: 6,
      rate: 500,
      start: "08:00",
      end: "18:00",
      modes: ["Cash", "UPI", "Card"],
      available: true
    },
    {
      name: "Mohan Plumbing Services",
      email: "mohan.plumber@example.com",
      phone: "9123456780",
      category: "Plumber",
      experience: 8,
      rate: 450,
      start: "09:00",
      end: "20:00",
      modes: ["Cash", "UPI", "Bank Transfer"],
      available: true
    },
    {
      name: "GreenLeaf Gardener",
      email: "greenleaf.gardener@example.com",
      phone: "9988776655",
      category: "Gardener",
      experience: 4,
      rate: 350,
      start: "07:00",
      end: "16:00",
      modes: ["Cash", "UPI"],
      available: false
    }
  ];

  for (const sample of samples) {
    const userId = data.meta.nextUserId++;
    data.users.push({
      id: userId,
      name: sample.name,
      email: sample.email,
      phone: sample.phone,
      passwordHash: bcrypt.hashSync("password123", 10),
      role: "provider",
      createdAt: new Date().toISOString()
    });
    data.providerProfiles.push({
      id: data.meta.nextProviderProfileId++,
      userId,
      serviceCategory: sample.category,
      experienceYears: sample.experience,
      hourlyRate: sample.rate,
      workStart: sample.start,
      workEnd: sample.end,
      paymentModes: sample.modes,
      availableNow: sample.available
    });
  }
}

function ensureDataShape(data) {
  data.meta = data.meta || {};
  data.meta.nextUserId = Number(data.meta.nextUserId || 1);
  data.meta.nextProviderProfileId = Number(data.meta.nextProviderProfileId || 1);
  data.meta.nextBookingId = Number(data.meta.nextBookingId || 1);
  data.meta.nextReviewId = Number(data.meta.nextReviewId || 1);
  data.meta.nextNotificationId = Number(data.meta.nextNotificationId || 1);
  data.users = Array.isArray(data.users) ? data.users : [];
  data.providerProfiles = Array.isArray(data.providerProfiles) ? data.providerProfiles : [];
  data.bookings = Array.isArray(data.bookings) ? data.bookings : [];
  data.reviews = Array.isArray(data.reviews) ? data.reviews : [];
  data.notifications = Array.isArray(data.notifications) ? data.notifications : [];

  for (const b of data.bookings) {
    if (b.acceptedAt === undefined) b.acceptedAt = null;
    if (b.completionDueAt === undefined) b.completionDueAt = null;
    if (b.completionOtp === undefined) b.completionOtp = null;
    if (b.completionOtpExpiresAt === undefined) b.completionOtpExpiresAt = null;
  }

  if (!data.users.some((u) => u.role === "admin" && u.email === "admin@household.local")) {
    const adminId = data.meta.nextUserId++;
    data.users.push({
      id: adminId,
      name: "System Admin",
      email: "admin@household.local",
      phone: "9000000000",
      passwordHash: bcrypt.hashSync("admin123", 10),
      role: "admin",
      createdAt: new Date().toISOString()
    });
  }
}

function htmlLayout(title, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; font-family: "Segoe UI", Arial, sans-serif; }
    body {
      margin: 0;
      color: #1e293b;
      background:
        radial-gradient(circle at 10% 20%, rgba(125, 211, 252, 0.2), transparent 32%),
        radial-gradient(circle at 85% 10%, rgba(196, 181, 253, 0.26), transparent 30%),
        linear-gradient(180deg, #f8fbff 0%, #f1f5ff 100%);
      min-height: 100vh;
    }
    .container { max-width: 1100px; margin: 24px auto; padding: 0 16px; }
    .card {
      background: rgba(255, 255, 255, 0.95);
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 16px;
      padding: 18px;
      margin-bottom: 16px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
      backdrop-filter: blur(3px);
    }
    .hero {
      position: relative;
      overflow: hidden;
      color: white;
      border-radius: 20px;
      background:
        linear-gradient(120deg, rgba(37, 99, 235, 0.93), rgba(59, 130, 246, 0.86)),
        url("https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=1400&q=80");
      background-size: cover;
      background-position: center;
      box-shadow: 0 18px 36px rgba(37, 99, 235, 0.3);
    }
    .hero::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(90deg, rgba(15, 23, 42, 0.4), rgba(15, 23, 42, 0.15));
      pointer-events: none;
    }
    .hero-content { position: relative; z-index: 1; padding: 30px 24px; }
    h1, h2, h3 { margin-top: 0; }
    .row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    @media (max-width: 860px) { .row { grid-template-columns: 1fr; } }
    label { font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px; }
    input, select, textarea, button {
      width: 100%;
      padding: 11px 12px;
      border-radius: 10px;
      border: 1px solid #cbd5e1;
      margin-bottom: 10px;
      transition: all 0.18s ease;
    }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: #60a5fa;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
    }
    textarea { min-height: 84px; resize: vertical; }
    button {
      background: linear-gradient(120deg, #2563eb, #3b82f6);
      color: white;
      border: none;
      cursor: pointer;
      font-weight: 600;
      box-shadow: 0 8px 16px rgba(37, 99, 235, 0.25);
    }
    button:hover { transform: translateY(-1px); box-shadow: 0 10px 18px rgba(37, 99, 235, 0.3); }
    button.secondary { background: #64748b; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .available { background: #dcfce7; color: #166534; }
    .unavailable { background: #fee2e2; color: #991b1b; }
    .pending { background: #fef9c3; color: #854d0e; }
    .accepted { background: #dbeafe; color: #1d4ed8; }
    .completed { background: #dcfce7; color: #166534; }
    .rejected { background: #fee2e2; color: #991b1b; }
    .cancelled { background: #e2e8f0; color: #334155; }
    .grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    @media (max-width: 860px) { .grid-3 { grid-template-columns: 1fr; } }
    .msg { background: #dbeafe; border: 1px solid #93c5fd; color: #1d4ed8; padding: 10px; border-radius: 8px; margin-bottom: 10px; }
    .inline { display: flex; gap: 8px; align-items: center; }
    .inline input[type='checkbox'] { width: auto; margin-bottom: 0; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 10px; }
    .header h2 { margin: 0; }
    .small { font-size: 13px; color: #475569; }
    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
    .stat-box { background: rgba(255, 255, 255, 0.2); border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 12px; padding: 10px; }
    .provider-card { transition: transform 0.2s ease, box-shadow 0.2s ease; }
    .provider-card:hover { transform: translateY(-3px); box-shadow: 0 14px 28px rgba(15, 23, 42, 0.12); }
    .provider-media { width: 100%; height: 160px; object-fit: cover; border-radius: 12px; margin-bottom: 10px; }
    .chip { display: inline-block; padding: 5px 10px; border-radius: 999px; margin-right: 6px; margin-bottom: 6px; font-size: 12px; background: #e2e8f0; color: #334155; }
    .icon-title { display: flex; align-items: center; gap: 8px; }
    .glass { background: rgba(255,255,255,0.78); border: 1px solid rgba(148,163,184,0.24); }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: left; font-size: 14px; }
    th { color: #334155; background: #f8fafc; }
    .stars { color: #eab308; font-weight: 700; }
    .muted { color: #64748b; font-size: 12px; }
    .notif-item { padding: 10px 12px; border-radius: 10px; margin-bottom: 8px; border: 1px solid #e2e8f0; background: #f8fafc; font-size: 14px; }
    .notif-item.unread { border-color: #93c5fd; background: #eff6ff; font-weight: 600; }
    .otp-box { border: 1px solid #f59e0b; background: #fffbeb; color: #92400e; padding: 12px; border-radius: 10px; margin-top: 10px; }
    .countdown { font-variant-numeric: tabular-nums; font-weight: 700; color: #1d4ed8; }
    .countdown.overdue { color: #b91c1c; }
  </style>
</head>
<body>
  <div class="container">${content}</div>
</body>
</html>`;
}

function renderHomePage(message = "") {
  return htmlLayout(
    "Household Services",
    `
    <div class="card hero">
      <div class="hero-content">
        <h1>Smart Home Services, On-Demand</h1>
        <p>Book trusted electricians, plumbers, cooks, gardeners and more in just a few clicks.</p>
        <div class="stats">
          <div class="stat-box"><strong>50+</strong><br/>Skilled Providers</div>
          <div class="stat-box"><strong>8+</strong><br/>Service Categories</div>
          <div class="stat-box"><strong>24x7</strong><br/>Easy Booking Flow</div>
        </div>
      </div>
    </div>
    <div class="card glass">
      ${message ? `<div class="msg">${message}</div>` : ""}
      <div class="row">
        <div class="card">
          <h2 class="icon-title"><span>🔐</span><span>Login</span></h2>
          <form method="POST" action="/login">
            <label>Email</label><input type="email" name="email" required />
            <label>Password</label><input type="password" name="password" required />
            <button type="submit">Login</button>
          </form>
          <p class="muted">Admin demo login: admin@household.local / admin123</p>
        </div>
        <div class="card">
          <h2 class="icon-title"><span>📝</span><span>Register</span></h2>
          <form method="POST" action="/register">
            <label>Name</label><input type="text" name="name" required />
            <label>Email</label><input type="email" name="email" required />
            <label>Phone</label><input type="text" name="phone" required />
            <label>Password</label><input type="password" name="password" required />
            <label>Register as</label>
            <select name="role" id="roleSelect" onchange="toggleProviderFields()">
              <option value="customer">Customer</option>
              <option value="provider">Service Provider</option>
            </select>

            <div id="providerFields" style="display:none;">
              <label>Service Category</label>
              <select name="serviceCategory">${SERVICES.map((s) => `<option>${s}</option>`).join("")}</select>
              <label>Experience (years)</label><input type="number" min="1" max="40" name="experienceYears" value="1" />
              <label>Hourly Rate</label><input type="number" min="100" step="10" name="hourlyRate" value="300" />
              <label>Working Hours Start</label><input type="time" name="workStart" value="09:00" />
              <label>Working Hours End</label><input type="time" name="workEnd" value="18:00" />
              <label>Payment Modes</label>
              ${PAYMENT_MODES.map((m) => `<div class="inline"><input type="checkbox" name="paymentModes" value="${m}"/><span>${m}</span></div>`).join("")}
              <div class="inline"><input type="checkbox" name="availableNow" checked /><span>Currently Available</span></div>
            </div>

            <button type="submit">Register</button>
          </form>
        </div>
      </div>
    </div>
    <script>
      function toggleProviderFields() {
        const role = document.getElementById('roleSelect').value;
        document.getElementById('providerFields').style.display = role === 'provider' ? 'block' : 'none';
      }
      toggleProviderFields();
    </script>
  `
  );
}

function renderCustomerDashboard({
  user,
  providers,
  services,
  paymentModes,
  bookings,
  filters,
  message,
  notifications = []
}) {
  const today = todayDateString();
  const unreadCount = notifications.filter((n) => !n.read).length;
  return htmlLayout(
    "Customer Dashboard",
    `
    <div class="card hero">
      <div class="hero-content">
        <div class="header">
          <h2>Welcome, ${escapeHtml(user.name)} (Customer)</h2>
          <form method="POST" action="/logout"><button class="secondary" type="submit">Logout</button></form>
        </div>
        <p>Choose the right professional, compare working hours and payment modes, then book instantly.</p>
      </div>
    </div>
    ${
      unreadCount
        ? `<div class="msg" role="status">You have <strong>${unreadCount}</strong> unread notification(s). Check the list below.</div>`
        : ""
    }
    ${message ? `<div class="msg">${escapeHtml(message)}</div>` : ""}
    <div class="card">
      <div class="header">
        <h3 class="icon-title"><span>🔔</span><span>Notifications</span></h3>
        ${
          notifications.length
            ? `<form method="POST" action="/customer/notifications/read"><button class="secondary" type="submit">Mark all read</button></form>`
            : ""
        }
      </div>
      ${
        notifications.length === 0
          ? '<p class="muted">No notifications yet. You will be notified when a provider accepts or declines a booking, or when completion is requested.</p>'
          : notifications
              .map(
                (n) => `
        <div class="notif-item ${n.read ? "" : "unread"}">
          ${escapeHtml(n.message)}
          <div class="muted" style="margin-top:6px;">${escapeHtml(n.createdAt)}</div>
        </div>`
              )
              .join("")
      }
    </div>
    <div class="card">
      <h3>Find Service Providers</h3>
      <form method="GET" action="/customer/dashboard" class="grid-3">
        <div>
          <label>Service</label>
          <select name="service">
            <option value="">All Services</option>
            ${services
              .map((s) => `<option ${filters.selectedService === s ? "selected" : ""} value="${s}">${s}</option>`)
              .join("")}
          </select>
        </div>
        <div>
          <label>Search Name/Skill</label>
          <input type="text" name="search" value="${escapeHtml(filters.search)}" placeholder="Search..." />
        </div>
        <div style="display:flex; align-items:end;">
          <button type="submit">Apply Filters</button>
        </div>
      </form>
    </div>

    <div class="card">
      <h3 class="icon-title"><span>🛠️</span><span>Available Providers</span></h3>
      ${
        providers.length === 0
          ? "<p>No providers found for this filter.</p>"
          : providers
              .map(
                (p) => `
                  <div class="card provider-card">
                    <img class="provider-media" src="${getServiceImage(p.serviceCategory)}" alt="${escapeHtml(
                  p.serviceCategory
                )}" />
                    <div class="header">
                      <h3>${escapeHtml(p.name)} - ${escapeHtml(p.serviceCategory)}</h3>
                      <span class="badge ${p.availableNow ? "available" : "unavailable"}">
                        ${p.availableNow ? "Available" : "Unavailable"}
                      </span>
                    </div>
                    <p class="small">
                      Experience: ${p.experienceYears} years | Rate: Rs.${p.hourlyRate}/hr | Working Hours: ${p.workStart} - ${p.workEnd}<br/>
                      Phone: ${escapeHtml(p.phone)} | Payment: ${escapeHtml(p.paymentModes.join(", ") || "N/A")}<br/>
                      <span class="stars">Rating: ${p.rating.toFixed(1)} / 5</span>
                    </p>
                    <div>${p.paymentModes.map((mode) => `<span class="chip">${escapeHtml(mode)}</span>`).join("")}</div>
                    <form method="POST" action="/bookings/create">
                      <input type="hidden" name="providerId" value="${p.providerId}" />
                      <div class="grid-3">
                        <div><label>Service Date</label><input type="date" min="${today}" name="serviceDate" required /></div>
                        <div><label>Service Time</label><input type="time" name="serviceTime" required /></div>
                        <div><label>Payment Mode</label>
                          <select name="paymentMode">${paymentModes
                            .map((m) => `<option value="${m}">${m}</option>`)
                            .join("")}</select>
                        </div>
                      </div>
                      <label>Address</label><textarea name="address" required placeholder="Enter complete service address"></textarea>
                      <label>Notes</label><textarea name="notes" placeholder="Optional details for the provider"></textarea>
                      <button type="submit">Book ${escapeHtml(p.serviceCategory)}</button>
                    </form>
                  </div>`
              )
              .join("")
      }
    </div>

    <div class="card">
      <h3>My Bookings</h3>
      ${
        bookings.length === 0
          ? "<p>No bookings yet.</p>"
          : bookings
              .map(
                (b) => `
                  <div class="card">
                    <div class="header">
                      <h3>${escapeHtml(b.providerName)} (${escapeHtml(b.serviceCategory)})</h3>
                      <span class="badge ${b.status.toLowerCase()}">${escapeHtml(b.status)}</span>
                    </div>
                    <p class="small">
                      Date: ${b.serviceDate} ${b.serviceTime} | Payment: ${escapeHtml(b.paymentMode)}<br/>
                      Address: ${escapeHtml(b.address)}<br/>
                      Notes: ${escapeHtml(b.notes || "N/A")}
                    </p>
                    ${
                      b.showOtpToCustomer
                        ? `<div class="otp-box">
                             <strong>Completion OTP</strong> (share with your provider only after the work is finished):<br/>
                             <span style="font-size:22px;letter-spacing:4px;font-weight:800;">${escapeHtml(
                               String(b.completionOtp)
                             )}</span>
                             <div class="muted">Valid until ${escapeHtml(b.completionOtpExpiresAt || "")}</div>
                           </div>`
                        : ""
                    }
                    ${
                      ["Pending", "Accepted"].includes(b.status)
                        ? `<form method="POST" action="/bookings/cancel">
                             <input type="hidden" name="bookingId" value="${b.id}" />
                             <button class="secondary" type="submit">Cancel Booking</button>
                           </form>`
                        : ""
                    }
                    ${
                      b.status === "Completed" && !b.hasReview
                        ? `<form method="POST" action="/reviews/create">
                             <input type="hidden" name="bookingId" value="${b.id}" />
                             <label>Rate this service (1-5)</label>
                             <select name="rating">
                               <option value="5">5 - Excellent</option>
                               <option value="4">4 - Good</option>
                               <option value="3">3 - Average</option>
                               <option value="2">2 - Poor</option>
                               <option value="1">1 - Bad</option>
                             </select>
                             <label>Comment</label>
                             <textarea name="comment" placeholder="Share your experience"></textarea>
                             <button type="submit">Submit Review</button>
                           </form>`
                        : ""
                    }
                    ${b.hasReview ? `<p class="muted">Review already submitted for this booking.</p>` : ""}
                  </div>`
              )
              .join("")
      }
    </div>
  `
  );
}

function renderProviderDashboard({ user, profile, services, paymentModes, bookings, reviews, averageRating, message }) {
  return htmlLayout(
    "Provider Dashboard",
    `
    <div class="card hero">
      <div class="hero-content">
        <div class="header">
          <h2>Welcome, ${escapeHtml(user.name)} (Service Provider)</h2>
          <form method="POST" action="/logout"><button class="secondary" type="submit">Logout</button></form>
        </div>
        <p>Manage your availability, update your profile, and handle incoming customer bookings smoothly.</p>
        <p><span class="stars">Average rating: ${averageRating.toFixed(1)} / 5</span></p>
      </div>
    </div>
    ${message ? `<div class="msg">${escapeHtml(message)}</div>` : ""}

    <div class="card">
      <h3 class="icon-title"><span>👤</span><span>My Service Profile</span></h3>
      <form method="POST" action="/provider/profile/update">
        <label>Service Category</label>
        <select name="serviceCategory">${services
          .map((s) => `<option ${profile.serviceCategory === s ? "selected" : ""}>${s}</option>`)
          .join("")}</select>
        <div class="grid-3">
          <div><label>Experience (years)</label><input type="number" name="experienceYears" value="${profile.experienceYears}" min="1" max="40" /></div>
          <div><label>Hourly Rate</label><input type="number" name="hourlyRate" value="${profile.hourlyRate}" min="100" step="10" /></div>
          <div>
            <label>Availability</label>
            <div class="inline"><input type="checkbox" name="availableNow" ${profile.availableNow ? "checked" : ""} /><span>Available for booking</span></div>
          </div>
        </div>
        <div class="grid-3">
          <div><label>Working Hours Start</label><input type="time" name="workStart" value="${profile.workStart}" /></div>
          <div><label>Working Hours End</label><input type="time" name="workEnd" value="${profile.workEnd}" /></div>
          <div>
            <label>Payment Modes</label>
            ${paymentModes
              .map(
                (m) => `
                  <div class="inline">
                    <input type="checkbox" name="paymentModes" value="${m}" ${
                  profile.paymentModes.includes(m) ? "checked" : ""
                } />
                    <span>${m}</span>
                  </div>`
              )
              .join("")}
          </div>
        </div>
        <button type="submit">Update Profile</button>
      </form>
    </div>

    <div class="card">
      <h3 class="icon-title"><span>📥</span><span>Incoming Bookings</span></h3>
      ${
        bookings.length === 0
          ? "<p>No bookings received yet.</p>"
          : bookings
              .map(
                (b) => `
                  <div class="card provider-card">
                    <div class="header">
                      <h3>${escapeHtml(b.customerName)} (${escapeHtml(b.customerPhone)})</h3>
                      <span class="badge ${b.status.toLowerCase()}">${escapeHtml(b.status)}</span>
                    </div>
                    <p class="small">
                      Date: ${b.serviceDate} ${b.serviceTime}<br/>
                      Address: ${escapeHtml(b.address)}<br/>
                      Payment Mode: ${escapeHtml(b.paymentMode)}<br/>
                      Notes: ${escapeHtml(b.notes || "N/A")}
                    </p>
                    ${
                      b.status === "Accepted" && b.completionDueAt
                        ? `<p class="small"><strong>Time remaining to complete (48h SLA):</strong>
                             <span class="countdown" data-deadline="${escapeHtml(b.completionDueAt)}">—</span></p>`
                        : ""
                    }
                    ${
                      b.otpAwaitingCustomer
                        ? `<p class="small" style="color:#b45309;">OTP sent to customer. Enter the code they give you below, keep status as <strong>Completed</strong>, and submit again.</p>`
                        : ""
                    }
                    <form method="POST" action="/provider/bookings/status">
                      <input type="hidden" name="bookingId" value="${b.id}" />
                      <div class="inline" style="flex-wrap:wrap;margin-bottom:8px;">
                        <select name="status" style="max-width:200px;margin-bottom:0;">
                        ${["Pending", "Accepted", "Rejected", "Completed", "Cancelled"]
                          .map((s) => `<option ${b.status === s ? "selected" : ""}>${s}</option>`)
                          .join("")}
                        </select>
                        <button type="submit">Update Status</button>
                      </div>
                      ${
                        b.status === "Accepted"
                          ? `<label>Completion OTP (from customer — required when status is Completed)</label>
                             <input type="text" name="completionOtp" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="Leave empty the first time you choose Completed to request OTP" />`
                          : `<input type="hidden" name="completionOtp" value="" />`
                      }
                    </form>
                  </div>`
              )
              .join("")
      }
    </div>
    <div class="card">
      <h3 class="icon-title"><span>⭐</span><span>Recent Customer Reviews</span></h3>
      ${
        reviews.length === 0
          ? "<p>No reviews yet. Complete bookings and provide quality service to get ratings.</p>"
          : reviews
              .slice(0, 10)
              .map(
                (r) => `<div class="card">
                          <p><strong>${escapeHtml(r.customerName)}</strong> <span class="stars">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span></p>
                          <p class="small">${escapeHtml(r.comment || "No comment provided.")}</p>
                        </div>`
              )
              .join("")
      }
    </div>
    <script>
      (function () {
        function tickAll() {
          document.querySelectorAll(".countdown[data-deadline]").forEach(function (el) {
            var raw = el.getAttribute("data-deadline");
            if (!raw) return;
            var end = new Date(raw).getTime();
            var ms = end - Date.now();
            if (ms <= 0) {
              el.textContent = "Overdue — complete as soon as possible.";
              el.classList.add("overdue");
              return;
            }
            var totalSec = Math.floor(ms / 1000);
            var h = Math.floor(totalSec / 3600);
            var m = Math.floor((totalSec % 3600) / 60);
            var s = totalSec % 60;
            el.textContent = h + "h " + m + "m " + s + "s";
            el.classList.remove("overdue");
          });
        }
        tickAll();
        setInterval(tickAll, 1000);
      })();
    </script>
  `
  );
}

function renderAdminDashboard({ user, stats, providers, bookings, message }) {
  return htmlLayout(
    "Admin Dashboard",
    `
    <div class="card hero">
      <div class="hero-content">
        <div class="header">
          <h2>Welcome, ${escapeHtml(user.name)} (Admin)</h2>
          <form method="POST" action="/logout"><button class="secondary" type="submit">Logout</button></form>
        </div>
        <p>Central control panel for platform analytics, provider management, and booking moderation.</p>
      </div>
    </div>
    ${message ? `<div class="msg">${escapeHtml(message)}</div>` : ""}
    <div class="card">
      <h3 class="icon-title"><span>📊</span><span>Platform Overview</span></h3>
      <div class="grid-3">
        <div class="card"><strong>${stats.customers}</strong><br/>Customers</div>
        <div class="card"><strong>${stats.providers}</strong><br/>Providers</div>
        <div class="card"><strong>${stats.bookings}</strong><br/>Total Bookings</div>
      </div>
      <div class="grid-3">
        <div class="card"><strong>${stats.completedBookings}</strong><br/>Completed Jobs</div>
        <div class="card"><strong>${stats.avgRating.toFixed(1)}</strong><br/>Avg Platform Rating</div>
        <div class="card"><strong>${stats.bookings ? Math.round((stats.completedBookings / stats.bookings) * 100) : 0}%</strong><br/>Completion Rate</div>
      </div>
    </div>

    <div class="card">
      <h3 class="icon-title"><span>🧑‍🔧</span><span>Provider Management</span></h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Category</th><th>Rating</th><th>Availability</th><th>Action</th></tr></thead>
          <tbody>
            ${
              providers
                .map(
                  (p) => `<tr>
                            <td>${escapeHtml(p.name)}</td>
                            <td>${escapeHtml(p.category)}</td>
                            <td>${p.rating.toFixed(1)} / 5</td>
                            <td>${p.availableNow ? "Available" : "Unavailable"}</td>
                            <td>
                              <form method="POST" action="/admin/providers/toggle">
                                <input type="hidden" name="providerId" value="${p.id}" />
                                <button type="submit">${p.availableNow ? "Set Unavailable" : "Set Available"}</button>
                              </form>
                            </td>
                          </tr>`
                )
                .join("")
            }
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3 class="icon-title"><span>📑</span><span>Latest Bookings (Admin Control)</span></h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Customer</th><th>Provider</th><th>Date</th><th>Status</th><th>Update</th></tr></thead>
          <tbody>
            ${
              bookings
                .map(
                  (b) => `<tr>
                            <td>${escapeHtml(b.customerName)}</td>
                            <td>${escapeHtml(b.providerName)}</td>
                            <td>${escapeHtml(b.serviceDate)} ${escapeHtml(b.serviceTime)}</td>
                            <td><span class="badge ${b.status.toLowerCase()}">${escapeHtml(b.status)}</span></td>
                            <td>
                              <form method="POST" action="/admin/bookings/status" class="inline">
                                <input type="hidden" name="bookingId" value="${b.id}" />
                                <select name="status">
                                  ${["Pending", "Accepted", "Rejected", "Completed", "Cancelled"]
                                    .map((s) => `<option ${b.status === s ? "selected" : ""}>${s}</option>`)
                                    .join("")}
                                </select>
                                <button type="submit">Save</button>
                              </form>
                            </td>
                          </tr>`
                )
                .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `
  );
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function calculateProviderRating(reviews, providerId) {
  const items = reviews.filter((r) => r.providerId === providerId);
  if (items.length === 0) return 0;
  const total = items.reduce((sum, r) => sum + Number(r.rating || 0), 0);
  return total / items.length;
}

function averageRating(reviews) {
  if (!reviews.length) return 0;
  const total = reviews.reduce((sum, r) => sum + Number(r.rating || 0), 0);
  return total / reviews.length;
}

function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isValidTimeRange(start, end) {
  return Boolean(start && end && start < end);
}

function getServiceImage(service) {
  const map = {
    Electrician:
      "https://images.unsplash.com/photo-1621905251918-48416bd8575a?auto=format&fit=crop&w=1200&q=80",
    Plumber:
      "https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=1200&q=80",
    Cook: "https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=1200&q=80",
    Gardener:
      "https://images.unsplash.com/photo-1599685315640-8a879ee5f96f?auto=format&fit=crop&w=1200&q=80",
    Carpenter:
      "https://images.unsplash.com/photo-1504148455328-c376907d081c?auto=format&fit=crop&w=1200&q=80",
    Cleaner:
      "https://images.unsplash.com/photo-1581578731420-c56f6f6f5084?auto=format&fit=crop&w=1200&q=80",
    Painter:
      "https://images.unsplash.com/photo-1562259949-e8e7689d7828?auto=format&fit=crop&w=1200&q=80",
    "AC Technician":
      "https://images.unsplash.com/photo-1621905252507-b35492cc74b4?auto=format&fit=crop&w=1200&q=80"
  };
  return map[service] || "https://images.unsplash.com/photo-1527515637462-daf57d9e2811?auto=format&fit=crop&w=1200&q=80";
}
